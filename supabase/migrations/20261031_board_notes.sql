-- Доска с заметками (board/): содержимое заметки лежит в data, см. board/board.js.
-- Доступ как у остальных таблиц сайта: всё для вошедших пользователей.
create table if not exists public.board_notes (
    id uuid primary key default gen_random_uuid(),
    data jsonb not null default '{}'::jsonb,
    created_by uuid default auth.uid() references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.board_notes enable row level security;

create policy "board_notes read" on public.board_notes for select to authenticated using (true);
create policy "board_notes insert" on public.board_notes for insert to authenticated with check (true);
create policy "board_notes update" on public.board_notes for update to authenticated using (true) with check (true);
create policy "board_notes delete" on public.board_notes for delete to authenticated using (true);
