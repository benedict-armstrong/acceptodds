import { allowedInstitutions } from '@/server/institution-domains';
import { SignUpForm } from './SignUpForm';

export const dynamic = 'force-dynamic';

export default function SignUp() {
  return (
    <main className="auth">
      <h1>Sign up</h1>
      <p className="fine">Open to email addresses at: {allowedInstitutions().join(', ') || 'no institutions yet'}.</p>
      <SignUpForm />
    </main>
  );
}
