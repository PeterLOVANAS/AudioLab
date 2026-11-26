// Lightweight visual aids. Hann-window STFT; normalized autocorrelation F0.
// No Praat-equivalence, calibrated SPL, formant or phoneme claims.
export function spectrum(frame,n){
 const re=new Float64Array(n),im=new Float64Array(n);let mean=0;for(const x of frame)mean+=x;mean/=frame.length;
 for(let i=0;i<frame.length;i++)re[i]=(frame[i]-mean)*(.5-.5*Math.cos(2*Math.PI*i/(frame.length-1)));
 for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)[re[i],re[j]]=[re[j],re[i]];}
 for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len;for(let i=0;i<n;i+=len)for(let j=0;j<len/2;j++){const c=Math.cos(angle*j),s=Math.sin(angle*j),k=i+j+len/2,tr=re[k]*c-im[k]*s,ti=re[k]*s+im[k]*c;re[k]=re[i+j]-tr;im[k]=im[i+j]-ti;re[i+j]+=tr;im[i+j]+=ti;}}
 return Float32Array.from({length:n/2},(_,i)=>20*Math.log10(Math.max(1e-8,2*Math.hypot(re[i],im[i])/frame.length)));
}
export function pitch(frame,rate,floor=60,ceiling=500){
 let mean=0,power=0;for(const x of frame)mean+=x;mean/=frame.length;const x=Float32Array.from(frame,v=>v-mean);for(const v of x)power+=v*v;if(Math.sqrt(power/x.length)<.008)return null;
 const low=Math.max(2,Math.floor(rate/ceiling)),high=Math.min(Math.ceil(rate/floor),Math.floor(x.length/2)),corr=new Float32Array(high+2);let best=0,lag=0;
 for(let k=low;k<=high+1;k++){let ab=0,aa=0,bb=0;for(let i=0;i<x.length-k;i++){ab+=x[i]*x[i+k];aa+=x[i]*x[i];bb+=x[i+k]*x[i+k]}corr[k]=ab/Math.sqrt(aa*bb||1);}
 for(let k=low+1;k<high;k++)if(corr[k]>corr[k-1]&&corr[k]>=corr[k+1]&&corr[k]>best){best=corr[k];lag=k;}
 if(best<.72||!lag)return null;
 // Prefer the first strong periodicity peak over multiples of its period.
 for(let k=low+1;k<lag;k++)if(corr[k]>corr[k-1]&&corr[k]>=corr[k+1]&&corr[k]>=best*.97){lag=k;break;}
 const denom=corr[lag-1]-2*corr[lag]+corr[lag+1],delta=denom?.5*(corr[lag-1]-corr[lag+1])/denom:0;
 const hz=rate/(lag+Math.max(-.5,Math.min(.5,delta)));return hz>=floor&&hz<=ceiling?hz:null;
}
export function cepstrum(column,binHz){
 const mel=f=>2595*Math.log10(1+f/700),hz=m=>700*(10**(m/2595)-1),top=mel(binHz*column.length),edges=Array.from({length:28},(_,i)=>hz(top*i/27)),logs=[];
 for(let b=1;b<=26;b++){let sum=0;for(let k=0;k<column.length;k++){const f=k*binHz,w=Math.max(0,Math.min((f-edges[b-1])/(edges[b]-edges[b-1]),(edges[b+1]-f)/(edges[b+1]-edges[b])));sum+=w*10**(column[k]/10)}logs.push(Math.log(Math.max(1e-12,sum)))}
 return Array.from({length:13},(_,i)=>logs.reduce((sum,v,j)=>sum+v*Math.cos(Math.PI*(i+1)*(j+.5)/26),0));
}
export function formants(frame,rate){
 const order=Math.min(18,2+Math.round(rate/1000)),x=new Float64Array(frame.length);let mean=0;for(const v of frame)mean+=v;mean/=frame.length;for(let i=1;i<x.length;i++)x[i]=((frame[i]-mean)-.97*(frame[i-1]-mean))*(.54-.46*Math.cos(2*Math.PI*i/(x.length-1)));
 const r=Array.from({length:order+1},(_,k)=>{let sum=0;for(let i=k;i<x.length;i++)sum+=x[i]*x[i-k];return sum});if(r[0]<1e-7)return [];
 let a=[1],error=r[0];for(let i=1;i<=order;i++){let sum=r[i];for(let j=1;j<i;j++)sum+=a[j]*r[i-j];const reflection=-sum/error;if(!Number.isFinite(reflection)||Math.abs(reflection)>=1)return [];const next=[...a,reflection];for(let j=1;j<i;j++)next[j]=a[j]+reflection*a[i-j];a=next;error*=1-reflection**2;}
 const envelope=[],step=25,max=Math.min(5500,rate/2-100);for(let f=0;f<=max;f+=step){let re=0,im=0;for(let k=0;k<a.length;k++){re+=a[k]*Math.cos(2*Math.PI*f*k/rate);im-=a[k]*Math.sin(2*Math.PI*f*k/rate)}envelope.push(-10*Math.log10(Math.max(1e-12,re*re+im*im)))}const peaks=[];for(let i=3;i<envelope.length-1;i++)if(envelope[i]>envelope[i-1]&&envelope[i]>=envelope[i+1])peaks.push(i*step);return peaks.slice(0,5);
}
export function analyze({samples,rate,start=0,windowMs=25,floor=60,ceiling=500,visibleOffset=0,visibleLength=samples.length}){
 const width=Math.min(800,Math.max(2,Math.ceil(visibleLength/rate/.01))),frameSize=Math.max(16,Math.round(rate*windowMs/1000)),n=2**Math.ceil(Math.log2(frameSize)),pitchSize=Math.ceil(rate*3/floor),columns=[],f0=[],energy=[],formantTracks=[],mfcc=[];
 for(let c=0;c<width;c++){const at=Math.floor(visibleOffset+c/(width-1)*Math.max(0,visibleLength-1));const frame=new Float32Array(frameSize);for(let i=0;i<frameSize;i++)frame[i]=samples[at+i-Math.floor(frameSize/2)]||0;const column=spectrum(frame,n);columns.push(column);mfcc.push(cepstrum(column,rate/n));formantTracks.push(formants(frame,rate));const pf=samples.slice(Math.max(0,at-Math.floor(pitchSize/2)),Math.min(samples.length,at+Math.ceil(pitchSize/2)));f0.push(pf.length>=pitchSize*.9?pitch(pf,rate,floor,ceiling):null);let sum=0;for(const x of frame)sum+=x*x;energy.push(20*Math.log10(Math.max(1e-6,Math.sqrt(sum/frame.length))));}
 return {columns,f0,energy,formantTracks,mfcc,start,duration:visibleLength/rate,binHz:rate/n,rate};
}
