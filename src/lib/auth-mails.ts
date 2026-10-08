import { renderMail, type RenderedMail } from './mail-html';

/**
 * The account mails: confirmation, sign-in, password and affiliation. Pure,
 * so they can be rendered without a database; `server/better-auth.ts` and
 * `server/affiliations.ts` send them. Every link is absolute to the app, and
 * the running head links to that link's origin.
 */

const SITE = 'acceptodds';

function mail(url: string, doc: Omit<Parameters<typeof renderMail>[0], 'siteUrl'>): RenderedMail {
  return renderMail({ siteUrl: new URL(url).origin, ...doc });
}

/** Sign-up's mail: a code for the page they are on, and a link. */
export function confirmationMail(code: string, url: string): RenderedMail {
  return mail(url, {
    subject: `${code} is your ${SITE} confirmation code`,
    title: 'Confirm your address',
    blocks: [
      { kind: 'code', label: 'Confirmation code', code, plain: `Your confirmation code is ${code}.` },
      { kind: 'p', text: 'Enter it on the page you signed up on, or open this link:' },
      { kind: 'link', label: 'Confirm my address', url },
      { kind: 'p', text: 'Both work for an hour. If you did not sign up, ignore this.' },
    ],
  });
}

/** Onboarding with an address that already has an account: a sign-in code and link, and the bet waits. */
export function existingAccountMail(code: string, url: string): RenderedMail {
  return mail(url, {
    subject: `${code} is your ${SITE} sign-in code`,
    title: 'You already have an account',
    blocks: [
      { kind: 'p', text: `This address already has an ${SITE} account, so we did not make a new one.` },
      { kind: 'code', label: 'Sign-in code', code, plain: `Your sign-in code is ${code}.` },
      { kind: 'p', text: 'Enter it on the page you were on, or open this link to sign in:' },
      { kind: 'link', label: 'Sign in', url },
      {
        kind: 'p',
        text:
          'Your bet is waiting there. The code and the link work for an hour, the link once. ' +
          'If you did not ask for this, ignore it; nothing has changed.',
      },
    ],
  });
}

export function magicLinkMail(url: string): RenderedMail {
  return mail(url, {
    subject: `Your ${SITE} sign-in link`,
    title: `Sign in to ${SITE}`,
    blocks: [
      { kind: 'p', text: `Open this link to sign in to ${SITE}. If you have no account yet, it makes one:` },
      { kind: 'link', label: 'Sign in', url },
      {
        kind: 'p',
        text: 'It works once, for an hour. If you did not ask for it, ignore this; nothing has changed.',
      },
    ],
  });
}

/** `first`: the account has no password yet (onboarding made it), so it is chosen, not reset. */
export function passwordMail(first: boolean, url: string): RenderedMail {
  if (first) {
    return mail(url, {
      subject: `Choose your ${SITE} password`,
      title: 'Choose a password',
      blocks: [
        {
          kind: 'p',
          text: `You have an ${SITE} account but no password yet. Open this link to choose one and sign in:`,
        },
        { kind: 'link', label: 'Choose a password', url },
        { kind: 'p', text: 'It works once, for an hour. If you did not ask for this, ignore it; nothing has changed.' },
      ],
    });
  }
  return mail(url, {
    subject: `Reset your ${SITE} password`,
    title: 'Reset your password',
    blocks: [
      { kind: 'p', text: 'Someone asked to reset the password for this address. If it was you:' },
      { kind: 'link', label: 'Reset my password', url },
      { kind: 'p', text: 'If not, ignore this.' },
    ],
  });
}

/** A code to confirm an added affiliation, typed on `profileUrl`. */
export function affiliationCodeMail(
  handle: string,
  institution: string,
  code: string,
  profileUrl: string,
): RenderedMail {
  return mail(profileUrl, {
    subject: `${code} is your ${SITE} affiliation code`,
    title: 'Confirm an affiliation',
    byline: institution,
    blocks: [
      { kind: 'p', text: `@${handle} asked to add this address as an affiliation (${institution}).` },
      { kind: 'p', text: 'If that was you, enter this code on your profile:', plain: '' },
      { kind: 'code', label: 'Affiliation code', code, plain: `If that was you, enter ${code} on your profile:` },
      { kind: 'link', label: 'Open my profile', url: profileUrl },
      { kind: 'p', text: 'It works for an hour. If not, ignore this; nothing changes without the code.' },
    ],
  });
}

/** Adding an address another account has confirmed: its owner is told, and no code is sent. */
export function affiliationTakenMail(handle: string, siteUrl: string): RenderedMail {
  return mail(siteUrl, {
    subject: `This address is already affiliated with an ${SITE} account`,
    title: 'Affiliation not added',
    blocks: [
      {
        kind: 'p',
        text:
          `@${handle} asked to add this address as an affiliation, but it already belongs to an account, ` +
          `so nothing was changed and no code was sent. An address can vouch for one account only.`,
      },
      { kind: 'p', text: 'If not, ignore this.' },
    ],
  });
}

/**
 * A code for the AI agent the person asked to trade for them
 * (`server/agent-codes.ts`). For an address with no account yet, the same
 * code also confirms it and makes the account.
 */
export function agentCodeMail(code: string, siteUrl: string, { newAccount }: { newAccount: boolean }): RenderedMail {
  return mail(siteUrl, {
    subject: `${code} is your ${SITE} agent code`,
    title: newAccount ? 'Your account, through your agent' : 'Sign in your agent',
    blocks: [
      {
        kind: 'p',
        text: newAccount
          ? `Your AI agent asked to make you an account on ${SITE}, a prediction market on which papers get accepted, and to trade for you there. If that was you, give it this code:`
          : `Your AI agent asked to sign in to ${SITE} as you. If that was you, give it this code:`,
      },
      { kind: 'code', label: 'Agent code', code, plain: `If that was you, give it this code: ${code}.` },
      {
        kind: 'p',
        text:
          (newAccount
            ? 'The code also confirms this address and makes your account, with its starting reputation. '
            : '') +
          'It works once, for 30 minutes, and gets the agent an API key that can trade as you. ' +
          (newAccount ? `Sign in to ${SITE} with this address any time to see what it does, and revoke` : 'Revoke') +
          ' the key under API keys on your profile at any time. If you did not ask for this, ignore it; ' +
          'nothing happens without the code.',
      },
    ],
  });
}
