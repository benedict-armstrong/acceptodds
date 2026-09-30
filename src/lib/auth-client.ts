'use client';

import { createAuthClient } from 'better-auth/react';
import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';

/** Better Auth's browser client, talking to /api/auth on this origin. */
export const authClient = createAuthClient({ plugins: [emailOTPClient(), magicLinkClient()] });
