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

// Registra o bot como novo MCP client via Dynamic Client Registration.
// Endpoint padrão OAuth2 DCR: POST {server}/register.
async function registerClient(redirectUri: string): Promise<DcrRegistrationResult> {
  const response = await fetch(`${MCP_SERVER_URL}/register`, {
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
  const codeVerifier = generateCodeVerifier();
  const challenge = await pkceChallenge(codeVerifier);

  const url = new URL(`${MCP_SERVER_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', registration.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

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
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: state.redirectUri,
    client_id: state.clientId,
    client_secret: state.clientSecret,
    code_verifier: state.codeVerifier,
  });
  const response = await fetch(`${MCP_SERVER_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

async function refreshAccessToken(tokens: CumbucaTokens): Promise<CumbucaTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
    client_secret: tokens.client_secret,
  });
  const response = await fetch(`${MCP_SERVER_URL}/token`, {
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
  const tokens = await getCurrentTokens();
  const { client, close } = await openMcpClient(tokens);
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
  } finally {
    await close();
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
