/** CLI bridge to the authoritative backend schema; no database writes or connections. */
const fs=require('node:fs'),path=require('node:path'),ts=require('@typescript/typescript6');
const root=path.resolve(__dirname,'..');
function load(file){const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>name.startsWith('@/')?load(name.slice(2)+'.ts'):require(name),mod,mod.exports);return mod.exports;}
try{
 const value=JSON.parse(fs.readFileSync(0,'utf8'));
 const parsed=load('lib/backend/validation/dataset-ingestion.ts').ingestionSchema.safeParse(value);
 if(!parsed.success){process.stderr.write(JSON.stringify(parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message})))+'\n');process.exitCode=1;}
 else process.stdout.write('Canonical schema valid\n');
}catch{process.stderr.write('Invalid JSON or schema validator unavailable\n');process.exitCode=1;}
