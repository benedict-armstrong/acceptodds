'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="linkbtn"
      onClick={async () => {
        await authClient.signOut();
        router.push('/');
        router.refresh();
      }}
    >
      sign out
    </button>
  );
}
