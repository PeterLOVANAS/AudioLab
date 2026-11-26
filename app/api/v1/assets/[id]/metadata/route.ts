import { env } from "cloudflare:workers";
import { authenticate, requireProjectAdmin, type AuthSettings } from "@/lib/backend/auth/identity";
import { localDevelopmentOnly } from "@/lib/backend/http/local-development";
import { readWavMetadata } from "@/lib/audio/wav-metadata";
/** Explicit local-admin repair for legacy assets with missing duration. Reads
 * existing R2 bytes, never uploads/replaces media or changes annotation records.
 * Authorization is repeated here as well as in the mandatory API proxy.
 */
export async function POST(request: Request, context: {params: Promise<{id:string}>}) {
  const denied = localDevelopmentOnly(request); if (denied) return denied;
  const user = await authenticate(env.DB, request, env as unknown as AuthSettings);
  const {id} = await context.params;
  const asset = await env.DB.prepare("SELECT a.storage_key AS key,d.project_id AS projectId FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id WHERE a.id=?").bind(id).first<{key:string;projectId:string}>();
  if (!asset) return Response.json({error:"Asset not found"},{status:404});
  await requireProjectAdmin(env.DB, asset.projectId, user.userId);
  try {
    const object = await env.AUDIO_BUCKET.get(asset.key, {range:{offset:0,length:256*1024}});
    if (!object) return Response.json({error:"R2 audio not found"},{status:404});
    const metadata = readWavMetadata(new Uint8Array(await object.arrayBuffer()), object.size);
    await env.DB.prepare("UPDATE audio_assets SET duration_seconds=?,sample_rate=?,channels=? WHERE id=?").bind(metadata.durationSeconds,metadata.sampleRate,metadata.channels,id).run();
    return Response.json({metadata});
  } catch (error) {return Response.json({error: error instanceof Error ? error.message : "Unable to read WAV metadata"},{status:422});}
}
