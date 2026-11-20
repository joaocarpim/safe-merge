/** O que o código tocou enquanto os testes rodavam (registrado com strace, só Linux). */
export interface Observed {
  /** Endereços IP:porta que os testes tentaram conectar (AF_INET/AF_INET6). */
  network: string[];
  /** Arquivos abertos fora do projeto e fora das pastas do sistema. */
  files: string[];
  /** Programas executados. */
  processes: string[];
}

const SYSTEM_PREFIXES = ['/usr/', '/lib/', '/lib64/', '/lib32/', '/bin/', '/sbin/', '/proc/', '/sys/', '/dev/', '/etc/ld.so', '/etc/localtime', '/etc/ssl/', '/etc/ca-certificates', '/etc/nsswitch.conf', '/etc/host.conf', '/etc/resolv.conf', '/etc/hosts', '/etc/gai.conf', '/run/', '/var/lib/', '/opt/', '/snap/', '/nix/'];

const MAX_ITEMS = 50;

/**
 * Lê a saída de `strace -f -e trace=connect,openat,execve -o arquivo`.
 * `projectDir` (a cópia temporária) e `allowDirs` (node_modules ligado, cache do npm…) não contam como "fora".
 */
export function parseStrace(text: string, projectDir: string, allowDirs: string[] = []): Observed {
  const network = new Set<string>();
  const files = new Set<string>();
  const processes = new Set<string>();
  const inside = [projectDir, ...allowDirs].map((d) => d.replace(/\/$/, ''));
  const tmpRoots = ['/tmp/', '/var/tmp/'];

  for (const line of text.split('\n')) {
    const connect = line.match(/connect\(\d+, \{sa_family=AF_INET6?, sin6?_port=htons\((\d+)\),.*?(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)")/);
    if (connect) {
      const ip = connect[2] ?? connect[3] ?? '?';
      if (ip !== '127.0.0.1' && ip !== '::1') network.add(`${ip}:${connect[1]}`);
      continue;
    }
    const open = line.match(/openat\([^,]+, "([^"]+)"/);
    if (open) {
      const p = open[1]!;
      if (!p.startsWith('/')) continue;
      if (inside.some((d) => p === d || p.startsWith(`${d}/`))) continue;
      if (SYSTEM_PREFIXES.some((s) => p.startsWith(s))) continue;
      if (tmpRoots.some((t) => p.startsWith(t))) continue;
      files.add(p);
      continue;
    }
    const exec = line.match(/execve\("([^"]+)"/);
    if (exec && !/ = -1 /.test(line)) processes.add(exec[1]!);
  }
  const cap = (s: Set<string>) => [...s].sort().slice(0, MAX_ITEMS);
  return { network: cap(network), files: cap(files), processes: cap(processes) };
}
