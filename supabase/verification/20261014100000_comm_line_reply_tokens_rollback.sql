-- Rollback for 20261014100000_comm_line_reply_tokens.sql.
-- Refuses while any unknown-outcome row exists: dropping it would let a
-- restart Reply/Push again (double-deliver). Resolve those rows first.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('public.comm_line_send_unknown') is not null
     and exists (select 1 from public.comm_line_send_unknown) then
    raise exception 'ROLLBACK_REFUSED: comm_line_send_unknown rows exist; a retry would double-deliver';
  end if;
end $$;
drop table if exists public.comm_line_send_unknown;
drop table if exists public.comm_line_reply_tokens;
commit;
