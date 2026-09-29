'use client';

import { createAuthClient } from 'better-auth/react';

/** Better Auth's browser client, talking to /api/auth on this origin. */
export const authClient = createAuthClient();
