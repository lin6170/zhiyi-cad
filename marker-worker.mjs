import { packMarker } from './marker-pack.mjs';
self.onmessage=event=>{
  try{const result=packMarker(event.data.project,event.data.config,{onProgress:progress=>self.postMessage({progress})});self.postMessage({result});}
  catch(error){self.postMessage({error:error.message});}
};
