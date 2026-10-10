-- Run against STAGING after every restore of production's data, through
-- scripts/staging-scrub.sh, which names the staging container. Never against
-- production: both databases are called `papermarket`.
--
-- Staging is a copy of production's database. Without this it holds working
-- production credentials: Better Auth stores session tokens in the clear, and
-- the API keys' hashes are what production looks a presented key up by. A
-- 6-digit code's hash is reversed by trying all million codes, so pending
-- codes go too. Passwords stay (salted, slow hashes): staging sign-in works.

begin;
delete from session;
delete from apikey;
delete from verification;
delete from agent_codes;
update affiliations set code_hash = null, code_expires_at = null where code_hash is not null;
commit;

select (select count(*) from session) as sessions,
       (select count(*) from apikey) as api_keys,
       (select count(*) from verification) as verifications,
       (select count(*) from agent_codes) as agent_codes,
       (select count(*) from affiliations where code_hash is not null) as pending_codes;
