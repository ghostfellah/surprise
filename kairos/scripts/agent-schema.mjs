// Génère les schémas publiés pour les agents à partir du code (une seule source de vérité) :
//   kairos/docs/agents/proposal.schema.json   et   kairos/docs/agents/mcp-tools.json
// Un test vérifie qu'ils sont à jour. Usage : node kairos/scripts/agent-schema.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposalJsonSchema, mcpToolList } from '../site/js/core/agent-tools.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '../docs/agents');
writeFileSync(join(out, 'proposal.schema.json'), JSON.stringify(proposalJsonSchema(), null, 2) + '\n');
writeFileSync(join(out, 'mcp-tools.json'), JSON.stringify({ tools: mcpToolList() }, null, 2) + '\n');
console.log('Schémas agents régénérés');
