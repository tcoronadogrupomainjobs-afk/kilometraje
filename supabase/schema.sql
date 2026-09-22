-- Esquema Supabase: control kilometraje
-- Pegar en Supabase Dashboard > SQL Editor y ejecutar.

-- 1. Perfiles (extiende auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nombre text not null default '',
  nif text default '',
  domicilio text not null default '',
  categoria text default 'PROFESOR TITULAR',
  proyecto text default 'CYL DIGITAL',
  rol text not null default 'profesor' check (rol in ('profesor','coordinador'))
);

-- 2. Viajes
create table if not exists public.viajes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  fecha date not null,
  origen text not null,
  via text not null default '',
  destino text not null,
  km numeric not null check (km > 0),
  motivo_codigo text default '',
  motivo_curso text not null default '',
  precio_km numeric not null default 0.26,
  total numeric not null,
  origen_geo text default '',
  via_geo text default '',
  destino_geo text default '',
  manual boolean default false,
  observaciones text default '',
  ruta_url text default '',
  proveedor text default '',
  created_at timestamptz default now()
);

-- 3. Ajustes (precio km editable por coordinador)
create table if not exists public.settings (
  clave text primary key,
  valor text not null
);
insert into public.settings (clave, valor)
values ('precio_km', '0.26')
on conflict (clave) do nothing;

-- 4. Trigger: al crear usuario en auth, crear perfil profesor por defecto
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, nombre, rol)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email,'@',1)), 'profesor')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. Helper: soy coordinador?
create or replace function public.soy_coordinador()
returns boolean language sql security definer stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and rol = 'coordinador');
$$;

-- 6. RLS
alter table public.profiles enable row level security;
alter table public.viajes enable row level security;
alter table public.settings enable row level security;

drop policy if exists "perfil propio" on public.profiles;
create policy "perfil propio" on public.profiles
  for select using (auth.uid() = id or public.soy_coordinador());

drop policy if exists "perfil update propio" on public.profiles;
create policy "perfil update propio" on public.profiles
  for update using (auth.uid() = id or public.soy_coordinador());

drop policy if exists "viajes select" on public.viajes;
create policy "viajes select" on public.viajes
  for select using (auth.uid() = user_id or public.soy_coordinador());

drop policy if exists "viajes insert" on public.viajes;
create policy "viajes insert" on public.viajes
  for insert with check (auth.uid() = user_id or public.soy_coordinador());

drop policy if exists "viajes update" on public.viajes;
create policy "viajes update" on public.viajes
  for update using (auth.uid() = user_id or public.soy_coordinador());

drop policy if exists "viajes delete" on public.viajes;
create policy "viajes delete" on public.viajes
  for delete using (auth.uid() = user_id or public.soy_coordinador());

drop policy if exists "settings read" on public.settings;
create policy "settings read" on public.settings
  for select using (true);

drop policy if exists "settings write coordi" on public.settings;
create policy "settings write coordi" on public.settings
  for all using (public.soy_coordinador()) with check (public.soy_coordinador());

-- 9. Certificados de asistencia (uno por viaje, anexados al PDF tras la tabla)
create table if not exists public.certificados (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viaje_id bigint not null unique references public.viajes(id) on delete cascade,
  nombre text not null default 'certificado.pdf',
  path text not null,
  tipo text not null default 'img', -- 'img' o 'pdf'
  created_at timestamptz default now()
);
alter table public.certificados enable row level security;
drop policy if exists "certs select" on public.certificados;
create policy "certs select" on public.certificados
  for select using (auth.uid() = user_id or public.soy_coordinador());
drop policy if exists "certs insert" on public.certificados;
create policy "certs insert" on public.certificados
  for insert with check (auth.uid() = user_id or public.soy_coordinador());
drop policy if exists "certs delete" on public.certificados;
create policy "certs delete" on public.certificados
  for delete using (auth.uid() = user_id or public.soy_coordinador());

insert into storage.buckets (id, name, public)
values ('certificados', 'certificados', false)
on conflict (id) do nothing;

drop policy if exists "certs own read" on storage.objects;
create policy "certs own read" on storage.objects
  for select using (bucket_id = 'certificados'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));
drop policy if exists "certs own write" on storage.objects;
create policy "certs own write" on storage.objects
  for insert with check (bucket_id = 'certificados'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));
drop policy if exists "certs own delete" on storage.objects;
create policy "certs own delete" on storage.objects
  for delete using (bucket_id = 'certificados'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));
-- 7b. Migracion por si ya ejecutaste el schema anterior:
alter table public.profiles add column if not exists domicilio text not null default '';alter table public.viajes add column if not exists via text not null default '';
alter table public.viajes add column if not exists via_geo text default '';
alter table public.viajes add column if not exists observaciones text default '';
alter table public.viajes add column if not exists ruta_url text default '';
alter table public.viajes add column if not exists proveedor text default '';

-- 8. Tickets de gasolina (capturas anexadas al PDF final)
create table if not exists public.tickets (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mes text not null,               -- 'YYYY-MM' (compatibilidad)
  fecha date default CURRENT_DATE, -- fecha del ticket (viaje asignado u hoy)
  viaje_id bigint references public.viajes(id) on delete set null, -- viaje al que va el ticket (null = general del periodo)
  nombre text not null default 'ticket.jpg',
  path text not null,               -- ruta en el bucket 'tickets'
  created_at timestamptz default now()
);
alter table public.tickets enable row level security;
drop policy if exists "tickets select" on public.tickets;
create policy "tickets select" on public.tickets
  for select using (auth.uid() = user_id or public.soy_coordinador());
drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert with check (auth.uid() = user_id or public.soy_coordinador());
drop policy if exists "tickets update" on public.tickets;
create policy "tickets update" on public.tickets
  for update using (auth.uid() = user_id or public.soy_coordinador())
  with check (auth.uid() = user_id or public.soy_coordinador());
drop policy if exists "tickets delete" on public.tickets;
create policy "tickets delete" on public.tickets
  for delete using (auth.uid() = user_id or public.soy_coordinador());

-- Bucket privado 'tickets' (crearlo tambien en Dashboard > Storage si prefieres)
insert into storage.buckets (id, name, public)
values ('tickets', 'tickets', false)
on conflict (id) do nothing;

-- Los ficheros se guardan como <user_id>/<mes>/<fichero>: cada uno solo los suyos
drop policy if exists "tickets own read" on storage.objects;
create policy "tickets own read" on storage.objects
  for select using (bucket_id = 'tickets'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));
drop policy if exists "tickets own write" on storage.objects;
create policy "tickets own write" on storage.objects
  for insert with check (bucket_id = 'tickets'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));
drop policy if exists "tickets own delete" on storage.objects;
create policy "tickets own delete" on storage.objects
  for delete using (bucket_id = 'tickets'
    and (auth.uid()::text = (storage.foldername(name))[1] or public.soy_coordinador()));

-- 7c. Migracion de tickets (despues de crear la tabla):
alter table public.tickets add column if not exists viaje_id bigint references public.viajes(id) on delete set null;
alter table public.tickets add column if not exists fecha date default CURRENT_DATE;
update public.tickets set fecha = (mes || '-01')::date where fecha is null;

-- 7. Realtime: ver bloque idempotente al final del archivo

-- 10. Tablon de anuncios: la coordinadora publica y las profesoras lo ven
create table if not exists public.anuncios (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  html text not null default '',
  created_at timestamptz default now()
);
alter table public.anuncios enable row level security;
drop policy if exists "anuncios read" on public.anuncios;
create policy "anuncios read" on public.anuncios
  for select using (true);
drop policy if exists "anuncios write coordi" on public.anuncios;
create policy "anuncios write coordi" on public.anuncios
  for all using (public.soy_coordinador()) with check (public.soy_coordinador());

-- 11. Realtime idempotente (se puede ejecutar todo el archivo las veces que sean
-- sin el error 42710 "already member of publication")
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'viajes') then
    alter publication supabase_realtime add table public.viajes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'certificados') then
    alter publication supabase_realtime add table public.certificados;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tickets') then
    alter publication supabase_realtime add table public.tickets;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'anuncios') then
    alter publication supabase_realtime add table public.anuncios;
  end if;
end $$;
