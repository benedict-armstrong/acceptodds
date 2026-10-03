/**
 * Whether an address has a `+tag` in its local part (`ada+x@ethz.ch`). Most
 * mail servers deliver every tag to the same inbox, so with them one person
 * could confirm any number of verified, funded accounts. They are refused
 * wherever an address is checked against the allowlist
 * (`institutionForEmail`), and the forms say why before sending.
 */
export function hasSubaddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  return email.slice(0, at < 0 ? undefined : at).includes('+');
}

/** What a form says to an address with a `+tag`. */
export const SUBADDRESS_REFUSED = 'Use your address without the “+…” part: one inbox, one account.';
