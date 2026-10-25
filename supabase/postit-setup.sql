-- 포스트잇 클리커 동기화용 표 (캘린더 프로젝트 안에 postit_ 이름으로 따로 둠)
-- 여러 번 실행해도 안전함

create table if not exists public.postit_boards (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  rev        bigint not null default 0,          -- 기기에서 고친 시각(ms). 더 큰 쪽이 이김
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.postit_notes (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  board_id   text not null,
  data       jsonb not null,
  rev        bigint not null default 0,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.postit_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  rev        bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists postit_boards_user_rev on public.postit_boards (user_id, rev);
create index if not exists postit_notes_user_rev  on public.postit_notes  (user_id, rev);

-- 내 것만 보고 고칠 수 있게
alter table public.postit_boards   enable row level security;
alter table public.postit_notes    enable row level security;
alter table public.postit_settings enable row level security;

drop policy if exists "postit_boards own" on public.postit_boards;
create policy "postit_boards own" on public.postit_boards
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "postit_notes own" on public.postit_notes;
create policy "postit_notes own" on public.postit_notes
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "postit_settings own" on public.postit_settings;
create policy "postit_settings own" on public.postit_settings
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 한 번에 올리기: 서버에 있는 것보다 새 것(rev가 큰 것)만 덮어씀
create or replace function public.postit_push(p_boards jsonb, p_notes jsonb, p_settings jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in'; end if;

  insert into public.postit_boards as t (id, user_id, data, rev, deleted, updated_at)
  select x->>'id', uid, coalesce(x->'data', '{}'::jsonb), (x->>'rev')::bigint, coalesce((x->>'deleted')::boolean, false), now()
  from jsonb_array_elements(coalesce(p_boards, '[]'::jsonb)) x
  on conflict (id) do update
    set data = excluded.data, rev = excluded.rev, deleted = excluded.deleted, updated_at = now()
    where t.rev < excluded.rev and t.user_id = uid;

  insert into public.postit_notes as t (id, user_id, board_id, data, rev, deleted, updated_at)
  select x->>'id', uid, coalesce(x->>'board_id', ''), coalesce(x->'data', '{}'::jsonb), (x->>'rev')::bigint, coalesce((x->>'deleted')::boolean, false), now()
  from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) x
  on conflict (id) do update
    set board_id = excluded.board_id, data = excluded.data, rev = excluded.rev, deleted = excluded.deleted, updated_at = now()
    where t.rev < excluded.rev and t.user_id = uid;

  if p_settings is not null then
    insert into public.postit_settings as t (user_id, data, rev, updated_at)
    values (uid, p_settings->'data', (p_settings->>'rev')::bigint, now())
    on conflict (user_id) do update
      set data = excluded.data, rev = excluded.rev, updated_at = now()
      where t.rev < excluded.rev;
  end if;
end;
$$;

revoke all on function public.postit_push(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.postit_push(jsonb, jsonb, jsonb) to authenticated;

-- 다른 기기에서 바뀌면 바로 알려주기
do $$
begin
  begin alter publication supabase_realtime add table public.postit_boards;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.postit_notes;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.postit_settings; exception when duplicate_object then null; end;
end $$;
