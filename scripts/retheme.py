import re, pathlib

FILES = [
    'src/components/auction/stats-bar.tsx',
    'src/components/auction/auction-grid.tsx',
    'src/components/auction/auction-room.tsx',
    'src/components/auction/load-test.tsx',
    'src/components/auction/design-doc.tsx',
]

REPL = [
    # borders
    ('border-white/10', 'border-border'),
    ('border-white/15', 'border-border'),
    ('border-white/20', 'border-border'),
    ('border-white/5', 'border-border'),
    # muted card surfaces
    ('bg-white/[0.03]', 'bg-card/70'),
    ('bg-white/[0.05]', 'bg-card/80'),
    ('bg-white/[0.06]', 'bg-accent'),
    ('bg-white/5', 'bg-muted/50'),
    ('bg-black/30', 'bg-muted/60'),
    ('bg-black/40', 'bg-muted/70'),
    # faint text tiers -> muted / strong
    ('text-white/20', 'text-muted-foreground/50'),
    ('text-white/30', 'text-muted-foreground/70'),
    ('text-white/35', 'text-muted-foreground/70'),
    ('text-white/40', 'text-muted-foreground'),
    ('text-white/50', 'text-muted-foreground'),
    ('text-white/60', 'text-muted-foreground'),
    ('text-white/70', 'text-foreground/80'),
    ('text-white/80', 'text-foreground/90'),
    ('text-white/90', 'text-foreground'),
    ('text-white', 'text-foreground'),
    # amber text readability on light theme
    ('text-amber-200', 'text-amber-700 dark:text-amber-300'),
    ('text-amber-100/80', 'text-amber-800/80 dark:text-amber-200/80'),
    ('text-amber-300', 'text-amber-600 dark:text-amber-300'),
    ('text-amber-400/80', 'text-amber-600/80 dark:text-amber-400/80'),
    ('text-amber-400/70', 'text-amber-600/70 dark:text-amber-400/70'),
    # success/danger text on light
    ('text-emerald-200', 'text-emerald-800 dark:text-emerald-200'),
    ('text-emerald-300', 'text-emerald-700 dark:text-emerald-300'),
    ('text-red-300', 'text-red-600 dark:text-red-300'),
    # hover surface
    ('hover:bg-white/[0.06]', 'hover:bg-accent'),
    ('group-hover:text-amber-300', 'group-hover:text-amber-600 dark:group-hover:text-amber-300'),
]

for f in FILES:
    p = pathlib.Path(f)
    s = p.read_text()
    for old, new in REPL:
        s = s.replace(old, new)
    p.write_text(s)
    print('rethemed', f)
