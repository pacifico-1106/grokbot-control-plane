begin;
set local lock_timeout = '5s';
do $rb$ begin
  if to_regclass('public.line_conversation_link_codes') is not null
     and exists (
       select 1 from public.line_conversation_link_codes
       where consumed_at is null and invalidated_at is null
     ) then
    raise exception 'ROLLBACK_REFUSED: unused line_conversation_link_codes exist; consume or invalidate them first';
  end if;
end $rb$;
drop table if exists public.line_conversation_link_codes;
commit;
