-- Арт-студия (studio/): рисунки хранятся текстом из команд, см. studio/studio.js.
-- Доступ как у остальных таблиц сайта: всё для вошедших пользователей.
create table if not exists public.drawings (
    id uuid primary key default gen_random_uuid(),
    title text not null default 'Без названия' check (length(title) <= 80),
    data text not null default 'S1 a' check (length(data) <= 3000000),
    created_by uuid default auth.uid() references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.drawings enable row level security;

create policy "drawings read" on public.drawings for select to authenticated using (true);
create policy "drawings insert" on public.drawings for insert to authenticated with check (true);
create policy "drawings update" on public.drawings for update to authenticated using (true) with check (true);
create policy "drawings delete" on public.drawings for delete to authenticated using (true);
