-- Configure the authorized 20-cell x 5-response sample without opening entry.
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
do $$
begin
  if (select setting_value from public.advice_transfer_settings
       where setting_key = 'formal_recruitment_open') is distinct from 'false'::jsonb then
    raise exception 'Prepare the sample only while formal recruitment is closed';
  end if;
  if exists (select 1 from public.advice_transfer_assignments where not is_test) then
    raise exception 'Formal participants already exist; inspect before resizing';
  end if;
  if (select setting_value from public.advice_transfer_settings
       where setting_key = 'formal_target_per_cell') not in ('0'::jsonb, '5'::jsonb) then
    raise exception 'Unexpected existing target; inspect before resizing';
  end if;
  update public.advice_transfer_settings
     set setting_value = '5'::jsonb, updated_at = now()
   where setting_key = 'formal_target_per_cell';
  perform public.ensure_advice_transfer_quota_tokens();
  if (select count(*) from public.advice_transfer_formal_cell_progress) <> 20
     or (select sum(token_total) from public.advice_transfer_formal_cell_progress) <> 100
     or exists (select 1 from public.advice_transfer_formal_cell_progress
                 where target_per_cell <> 5 or token_total <> 5 or not quota_invariant_ok) then
    raise exception 'Expected exactly 20 balanced cells with 5 tokens each';
  end if;
end;
$$;
commit;
select setting_key, setting_value from public.advice_transfer_settings
 where setting_key in ('formal_recruitment_open', 'formal_target_per_cell');
