'use client';

import { useState } from 'react';
import { agentPrompt } from '@/lib/agent-prompt';
import { track } from '@/lib/track';
import { CopyField } from './CopyField';
import { ui } from './ui';

/**
 * Puts `text` on the clipboard once `pending` resolves. Safari drops the
 * click's permission to write across an `await`, so the write starts in the
 * click itself and is handed the text as a promise; elsewhere, written after.
 */
async function copyWhenReady(pending: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    }
  } catch {
    // Fall through: some browsers refuse a promised item.
  }
  try {
    await navigator.clipboard.writeText(await pending);
    return true;
  } catch {
    return false;
  }
}

/**
 * `[onboard your agent]`: copies `lib/agent-prompt.ts`'s prompt for the
 * viewer's AI agent. Signed in, the prompt carries a one-time code for an
 * API key (`POST /api/v1/me/agent-code`, a new one each press, 15 minutes),
 * so the agent signs in without a mail; signed out, the agent signs in by a
 * code mailed to the person (`/agent/start`). Where there is no clipboard,
 * the prompt is shown to copy by hand.
 */
export function OnboardAgent({
  signedIn,
  className = ui.linkBtn,
  label = '[onboard your agent]',
  copiedLabel = '[prompt copied]',
}: {
  signedIn: boolean;
  className?: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'shown' | 'failed'>('idle');
  const [prompt, setPrompt] = useState('');

  async function build(): Promise<string> {
    let signIn: { email: string; code: string } | undefined;
    if (signedIn) {
      const res = await fetch('/api/v1/me/agent-code', { method: 'POST' });
      if (!res.ok) throw new Error('agent-code');
      const { email, code } = await res.json();
      signIn = { email, code };
    }
    const text = agentPrompt(window.location.origin, signIn);
    setPrompt(text);
    return text;
  }

  async function press() {
    setState('busy');
    const pending = build();
    // Not awaited first: the copy has to start inside the click.
    const copied = await copyWhenReady(pending);
    try {
      await pending;
    } catch {
      setState('failed');
      return;
    }
    if (copied) track('agent_prompt_copied');
    setState(copied ? 'copied' : 'shown');
  }

  return (
    <div>
      <button type="button" className={className} disabled={state === 'busy'} onClick={() => void press()}>
        {state === 'copied' ? copiedLabel : label}
      </button>
      {state === 'copied' && <p className={ui.fine}>Paste it into your AI agent.</p>}
      {state === 'shown' && (
        <div className="mt-2 text-left">
          <p className={`${ui.fine} mb-1`}>Copy this into your AI agent:</p>
          <CopyField value={prompt} label="Prompt for your AI agent" multiline />
        </div>
      )}
      {state === 'failed' && <div className={ui.note(false)}>Could not make the prompt. Try again in a moment.</div>}
    </div>
  );
}
