import { migrate } from "../src/lib/db/migrate";

async function main() {
  const applied = await migrate();
  if (applied.length === 0) {
    console.log("Schema already up to date.");
    return;
  }
  console.log(`Applied ${applied.length} migration(s):`);
  for (const name of applied) console.log(`  ${name}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
