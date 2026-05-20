import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  hasTokens,
  readTokens,
  writeTokens,
  isAccessTokenExpired,
  type CumbucaTokens,
} from './cumbuca.tokens.js';
import type {
  CumbucaListAccountsResponse,
  CumbucaListTransactionsResponse,
  CumbucaConsentStatus,
} from './cumbuca.types.js';

const MCP_SERVER_URL = 'https://mcp.cumbuca.com/mcp';

// Timeout de rede pra cada chamada HTTP. Sem isso, uma conexão pendurada
// (TCP sem resposta) travaria o scanner indefinidamente porque o
// `runScanAndReschedule` nunca chegaria no `finally`.
const HTTP_TIMEOUT_MS = 30_000;

function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Estado de conectividade em memória — não persiste. Refletido pelo último
// resultado de uma operação contra o MCP.
let connected = true;

function markConnected(): void {
  connected = true;
}

function markDisconnected(reason: string): void {
  if (connected) {
    console.error('[cumbuca] disconnected:', reason);
  }
  connected = false;
}

export function isConnected(): boolean {
  return connected;
}

// -------------- OAuth metadata discovery --------------

// MCP servers expõem onde fica o authorization server via RFC 9728 (Protected
// Resource Metadata). No caso do Cumbuca não dá pra chumbar /register,
// /authorize e /token no host do MCP server: o resource server fica em
// `mcp.cumbuca.com` mas o auth server é um Keycloak separado em
// `idc.cumbuca.com/realms/cumbuca-mcp`. Sem discovery, todo POST cai no
// handler MCP genérico e volta 401 em JSON-RPC.

interface OAuthServerMetadata {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

let cachedAuthServerMetadata: OAuthServerMetadata | null = null;

async function discoverAuthServerMetadata(): Promise<OAuthServerMetadata> {
  if (cachedAuthServerMetadata) return cachedAuthServerMetadata;

  const resourceOrigin = new URL(MCP_SERVER_URL).origin;
  const protectedResourceResponse = await fetchWithTimeout(
    `${resourceOrigin}/.well-known/oauth-protected-resource`,
  );
  if (!protectedResourceResponse.ok) {
    throw new Error(
      `Failed to fetch protected resource metadata: ${protectedResourceResponse.status}`,
    );
  }
  const protectedResource = (await protectedResourceResponse.json()) as {
    authorization_servers?: string[];
  };
  const authServerUrl = protectedResource.authorization_servers?.[0];
  if (!authServerUrl) {
    throw new Error('Protected resource metadata missing authorization_servers');
  }

  const authServerResponse = await fetchWithTimeout(
    `${authServerUrl}/.well-known/oauth-authorization-server`,
    { redirect: 'follow' },
  );
  if (!authServerResponse.ok) {
    throw new Error(
      `Failed to fetch authorization server metadata: ${authServerResponse.status}`,
    );
  }
  const metadata = (await authServerResponse.json()) as Partial<OAuthServerMetadata>;
  if (
    !metadata.registration_endpoint ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint
  ) {
    throw new Error(
      `Incomplete authorization server metadata: ${JSON.stringify(metadata)}`,
    );
  }
  cachedAuthServerMetadata = metadata as OAuthServerMetadata;
  return cachedAuthServerMetadata;
}

// -------------- OAuth / DCR --------------

interface DcrRegistrationResult {
  client_id: string;
  client_secret: string;
  // (Cumbuca retorna outros campos; só guardamos os essenciais.)
}

export interface AuthFlowStart {
  authorizationUrl: string;
  // Mantém o state codeVerifier in-memory durante o link flow; é trocado
  // junto com o `code` no callback.
  state: {
    clientId: string;
    clientSecret: string;
    codeVerifier: string;
    redirectUri: string;
  };
}

async function registerClient(redirectUri: string): Promise<DcrRegistrationResult> {
  const { registration_endpoint } = await discoverAuthServerMetadata();
  const response = await fetchWithTimeout(registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'racha-conta-bot',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  if (!response.ok) {
    throw new Error(`DCR failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as DcrRegistrationResult;
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(hash).toString('base64url');
}

export async function startAuthFlow(redirectUri: string): Promise<AuthFlowStart> {
  const registration = await registerClient(redirectUri);
  const { authorization_endpoint } = await discoverAuthServerMetadata();
  const codeVerifier = generateCodeVerifier();
  const challenge = await pkceChallenge(codeVerifier);

  const url = new URL(authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', registration.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Cumbuca anuncia `openid open-finance offline_access`. Precisamos do
  // `open-finance` pra acessar dados via Open Finance (caminho real até o
  // banco do user) e do `offline_access` pra ganhar refresh_token.
  url.searchParams.set('scope', 'openid open-finance offline_access');

  return {
    authorizationUrl: url.toString(),
    state: {
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      codeVerifier,
      redirectUri,
    },
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: AuthFlowStart['state'],
): Promise<TokenResponse> {
  const { token_endpoint } = await discoverAuthServerMetadata();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: state.redirectUri,
    client_id: state.clientId,
    client_secret: state.clientSecret,
    code_verifier: state.codeVerifier,
  });
  const response = await fetchWithTimeout(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

// Serialização de refresh: dois callers concorrentes que detectam token
// expirado ao mesmo tempo iriam disparar dois POSTs /token. O Cumbuca rotaciona
// `refresh_token` a cada resposta, então last-write-wins no arquivo e o caller
// perdedor fica com refresh_token inválido — brickando a integração até
// rodar `cumbuca:link` de novo. O Promise compartilhado garante que só um
// HTTP request acontece e os outros recebem o mesmo resultado.
let inFlightRefresh: Promise<CumbucaTokens> | null = null;

async function refreshAccessToken(tokens: CumbucaTokens): Promise<CumbucaTokens> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      const { token_endpoint } = await discoverAuthServerMetadata();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: tokens.client_id,
        client_secret: tokens.client_secret,
      });
      const response = await fetchWithTimeout(token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        markDisconnected(`refresh failed: ${response.status}`);
        throw new Error(`Refresh failed: ${response.status} ${await response.text()}`);
      }
      const refreshed = (await response.json()) as TokenResponse;
      const updated: CumbucaTokens = {
        ...tokens,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
        expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      };
      await writeTokens(updated);
      return updated;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

// -------------- MCP tool calls --------------

async function getCurrentTokens(): Promise<CumbucaTokens> {
  if (!(await hasTokens())) {
    throw new Error('No Cumbuca tokens present. Run `npm run cumbuca:link`.');
  }
  let tokens = await readTokens();
  if (isAccessTokenExpired(tokens)) {
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

async function openMcpClient(tokens: CumbucaTokens): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  });
  const client = new Client({ name: 'racha-conta-bot', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function callMcpTool<TResult>(
  toolName: string,
  args: Record<string, unknown>,
): Promise<TResult> {
  // Qualquer erro no caminho de tokens → connect → callTool → parse marca o
  // cliente como desconectado. O flag `connected` é a única fonte de verdade
  // pra um futuro consumidor (health endpoint / alerta WhatsApp), então tem
  // que refletir o estado real, não só a falha de refresh.
  let tokens: CumbucaTokens;
  try {
    tokens = await getCurrentTokens();
  } catch (error) {
    markDisconnected(`token unavailable: ${(error as Error).message}`);
    throw error;
  }

  let client: Client;
  let close: () => Promise<void>;
  try {
    const opened = await openMcpClient(tokens);
    client = opened.client;
    close = opened.close;
  } catch (error) {
    markDisconnected(`mcp connect failed: ${(error as Error).message}`);
    throw error;
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    markConnected();
    // Resultados de tools MCP vêm em `content[]`; pegamos o primeiro bloco de
    // texto contendo o JSON da resposta. O shape com `toolResult` é da forma
    // de compatibilidade antiga e não é usado por Cumbuca.
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find(
      (block) => block.type === 'text' && typeof block.text === 'string',
    );
    if (!textBlock?.text) {
      throw new Error(`Unexpected MCP response shape for ${toolName}: ${JSON.stringify(result)}`);
    }
    return JSON.parse(textBlock.text) as TResult;
  } catch (error) {
    markDisconnected(`tool ${toolName} failed: ${(error as Error).message}`);
    throw error;
  } finally {
    // Swallow close errors: se a tool call já falhou, o erro original é mais
    // útil que o cleanup. Só logamos pra trace.
    try {
      await close();
    } catch (closeError) {
      console.warn('[cumbuca] mcp close failed', closeError);
    }
  }
}

// -------------- Public surface --------------

export async function getConsentStatus(): Promise<CumbucaConsentStatus> {
  return callMcpTool<CumbucaConsentStatus>('get_consent_status', {});
}

export async function listAccounts(): Promise<CumbucaListAccountsResponse> {
  return callMcpTool<CumbucaListAccountsResponse>('list_accounts', {});
}

export async function listAccountTransactions(args: {
  accountId: string;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
}): Promise<CumbucaListTransactionsResponse> {
  return callMcpTool<CumbucaListTransactionsResponse>('list_account_transactions', {
    account_id: args.accountId,
    from_date: args.fromDate,
    to_date: args.toDate,
  });
}
