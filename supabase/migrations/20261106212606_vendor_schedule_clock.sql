-- A2.b.vi: pure schedule calculation only. No source, schedule, cron or runner
-- is enabled, and existing interval-based hosted pulls remain unchanged.
begin;
create schema if not exists kerdos_private;

-- ISO weekdays: Monday=1 through Sunday=7. The result is strictly after
-- p_after. A missed local hour uses PostgreSQL's pre-transition offset;
-- a repeated hour uses its post-transition offset (one occurrence per date).
-- An entirely skipped civil date is omitted rather than moved to another day.
create or replace function kerdos_private.next_scheduled_at(
 p_weekdays smallint[], p_local_time time without time zone,
 p_timezone text, p_after timestamp with time zone
) returns timestamp with time zone
language plpgsql stable security invoker set search_path='' as $$
declare
 first_date date;
 local_date date;
 candidate timestamp with time zone;
 result timestamp with time zone;
 day_offset integer;
begin
 if p_weekdays is null or cardinality(p_weekdays) not between 1 and 7
   or array_ndims(p_weekdays)<>1
   or exists(select 1 from unnest(p_weekdays) as d(value) where value is null or value not between 1 and 7)
   or (select count(distinct value) from unnest(p_weekdays) as d(value))<>cardinality(p_weekdays)
   or p_local_time is null or p_local_time>=time '24:00'
   or p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone)
   or p_after is null or not isfinite(p_after) then
  raise exception using errcode='22023',message='invalid_vendor_schedule';
 end if;
 first_date:=(p_after at time zone p_timezone)::date;
 -- Two weeks cover a weekly recurrence whose first civil date was skipped.
 for day_offset in 0..14 loop
  local_date:=first_date+day_offset;
  if extract(isodow from local_date)::integer=any(p_weekdays) then
   candidate:=(local_date+p_local_time) at time zone p_timezone;
   if (candidate at time zone p_timezone)::date=local_date
     and candidate>p_after and (result is null or candidate<result) then
    result:=candidate;
   end if;
  end if;
 end loop;
 if result is null then
  raise exception using errcode='22023',message='vendor_schedule_not_resolved';
 end if;
 return result;
end;$$;

-- Future owned RPCs can call this helper; it is not a public scheduling API.
revoke all on function kerdos_private.next_scheduled_at(smallint[],time without time zone,text,timestamp with time zone)
 from public,anon,authenticated,service_role;
commit;
