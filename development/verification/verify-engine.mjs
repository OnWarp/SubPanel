import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateTemplate } from '../../worker/templates/validation.ts';

const action = process.argv[2];

if (action === 'validate') {
  const filePath = process.argv[3];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = validateTemplate(content);
    console.log(JSON.stringify({ success: true, ignored: result.ignored }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
} else if (action === 'naive-render') {
  const fixturePath = process.argv[3];
  const nodesPath = process.argv[4];
  const outPath = process.argv[5];

  try {
    const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
    const nodes = JSON.parse(fs.readFileSync(nodesPath, 'utf-8'));
    const parsed = YAML.parse(fixtureContent);

    const proxyNames = nodes.map(n => n.displayName || n.name);
    const proxies = nodes.map(n => {
      const p = {
        name: n.displayName || n.name,
        type: n.protocol === 'shadowsocks' ? 'ss' : n.protocol,
        server: n.server,
        port: n.port,
      };
      if (n.credentials?.method) p.cipher = n.credentials.method;
      if (n.credentials?.security) p.cipher = n.credentials.security;
      if (n.credentials?.password) p.password = n.credentials.password;
      if (n.credentials?.uuid) p.uuid = n.credentials.uuid;
      if (n.credentials?.alterId !== undefined) p.alterId = Number(n.credentials.alterId);
      if (n.tls?.tls) p.tls = true;
      if (n.tls?.sni) p.sni = n.tls.sni;
      if (n.transport?.type) {
        p.network = n.transport.type;
        if (n.transport.type === 'ws' && n.transport.path) {
          p['ws-opts'] = { path: n.transport.path };
        }
      }
      return p;
    });

    if (parsed && parsed['proxy-groups']) {
      for (const group of parsed['proxy-groups']) {
        if (Array.isArray(group.proxies)) {
          group.proxies = group.proxies.flatMap(item => (item === '$SUBPANEL_NODES' ? proxyNames : [item]));
        }
      }
    }

    const rendered = {
      proxies,
      ...(parsed || {}),
    };

    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(outPath, YAML.stringify(rendered), 'utf-8');
    console.log(JSON.stringify({ success: true, count: proxies.length }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
  }
} else {
  console.error(`Unknown action: ${action}`);
  process.exit(1);
}
