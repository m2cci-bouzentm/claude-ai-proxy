export interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
}

export interface AuthResult {
    accessToken: string;
    subscriptionType: string | null;
    rateLimitTier: string | null;
}

export interface KeychainTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
}

export interface CredentialsFile {
    claudeAiOauth?: KeychainTokens;
}

export interface OAuthEntry {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    scopes?: string[];
    subscriptionType: string | null;
    rateLimitTier: string | null;
}

export interface AuthStatus {
    configured: boolean;
    type: "oauth" | null;
    provider: "claude";
    expiresAt: string | null;
    isExpired: boolean;
    accessPresent: boolean;
    refreshPresent: boolean;
    accountIdPresent: false;
    subscriptionType: string | null;
    rateLimitTier: string | null;
}
