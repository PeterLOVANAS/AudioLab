/**
 * Overlap-aware interval lane packing, adapted from prototype.
 * Rendering overlaps in independent lanes does NOT change their timestamps.
 * The packing algorithm takes a sorted list and puts each item in the first
 * lane whose last interval ends before this item starts.
 */
// Pack intervals into lanes without hiding simultaneous labels. Never changes annotation times.
export function timelineLanes(items:any[],separate=false,speech=false):{label:string;items:any[]}[]{
 const groups=new Map<string,any[]>();
 for(const item of [...items].sort((a,b)=>a.start-b.start||a.end-b.end)){
  const group=speech?(item.speaker||'Unassigned speaker'):separate?(item.text||'Unlabelled'):'Overlapping events';
  groups.set(group,[...(groups.get(group)||[]),item]);
 }
 const out:{label:string;items:any[]}[]=[];
 for(const [group,values]of groups){const lanes:any[][]=[];for(const v of values){let lane=lanes.find(l=>l[l.length-1].end<=v.start);if(!lane){lane=[];lanes.push(lane)}lane.push(v)}lanes.forEach((items,i)=>out.push({label:group+(lanes.length>1?` · ${i+1}`:''),items}))}
 return out;
}
export function speechGridTiers(words:any[],phones:any[]){return [{name:'words',items:words},{name:'phones',items:phones}].flatMap(t=>timelineLanes(t.items,true,true).map(l=>({name:`${l.label} · ${t.name}`,items:l.items})));}
