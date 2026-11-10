import {analyze} from './acoustic-analysis.mjs';
self.onmessage=({data})=>{try{self.postMessage({id:data.id,result:analyze(data)})}catch(e){self.postMessage({id:data.id,error:e.message})}};
