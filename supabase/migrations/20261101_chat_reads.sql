-- Отметка «прочитано до» для чата: непрочитанные и двойные галочки, см. live.js.
-- Прочитать могут оба, менять — только свою строку.
create table if not exists public.chat_reads (
    user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
    last_read_at timestamptz not null default now()
);

alter table public.chat_reads enable row level security;

create policy "chat_reads read" on public.chat_reads for select to authenticated using (true);
create policy "chat_reads insert" on public.chat_reads for insert to authenticated with check (auth.uid() = user_id);
create policy "chat_reads update" on public.chat_reads for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
