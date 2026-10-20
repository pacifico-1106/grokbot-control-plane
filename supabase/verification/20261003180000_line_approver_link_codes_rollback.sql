-- Rollback for 20261003180000_line_approver_link_codes.sql.
-- Refuse while an unused (not consumed, not invalidated) code exists: dropping
-- the table would make a live 15-minute code silently vanish. Consume or
-- invalidate those rows first, then roll back. Flag LINE_APPROVER_LINK_ENABLED
-- must be OFF (this file is not applied to production by the L0 PR).
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('public.line_approver_link_codes') is not null
     and exists (
       select 1 from public.line_approver_link_codes
       where consumed_at is null and invalidated_at is null
     ) then
    raise exception 'ROLLBACK_REFUSED: unused line_approver_link_codes exist; consume or invalidate them first';
  end if;
end $$;
drop table if exists public.line_approver_link_codes;
commit;
