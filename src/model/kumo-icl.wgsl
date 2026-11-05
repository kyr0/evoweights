// Frozen-support Kumo Small, 12 in-context Transformer blocks and the first output MLP.
// Each dispatch is one true data dependency. Offsets are in float elements.
struct Command { a: vec4u, b: vec4u, c: vec4u }
@group(0) @binding(0) var<storage,read> w: array<f32>;
@group(0) @binding(1) var<storage,read_write> s: array<f32>;
@group(0) @binding(2) var<uniform> u: Command;
var<workgroup> sums: array<f32,64>;

fn gelu(x:f32)->f32 {
    if(x>7.0){return x;}
    if(x < -7.0){return 0.0;}
    let v=abs(x)*0.7071067811865475;
    let t=1.0/(1.0+0.3275911*v);
    let poly=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t;
    let e=1.0-poly*exp(-v*v);
    return 0.5*x*(1.0+select(e,-e,x<0.0));
}
@compute @workgroup_size(64)
fn normalize(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
    let h=group.x; let n=u.a.z;
    let source=u.a.x+h*n; let dest=u.a.y+h*n;
    var val=0.0;
    for(var k=lane;k<n;k+=64u){val+=s[source+k]*s[source+k];}
    sums[lane]=val;workgroupBarrier();
    for(var stride=32u;stride>0u;stride>>=1u){
        if(lane<stride){sums[lane]+=sums[lane+stride];}
        workgroupBarrier();
    }
    let inv=inverseSqrt(sums[0]/f32(n)+bitcast<f32>(u.b.y));
    var scale=1.0;if(u.b.x!=0u){scale=w[u.b.x+h];}
    for(var k=lane;k<n;k+=64u){
        var coeff=1.0;if(u.a.w!=0u){coeff=w[u.a.w+k];}
        s[dest+k]=((s[source+k]*inv)*coeff)*scale;
    }
}
@compute @workgroup_size(64)
fn matrix(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
    let row=group.x*4u+lane/16u;let colLane=lane&15u;
    let n=u.a.z;let rowStart=u.b.x+row*n;
    var dot=0.0;
    for(var k=colLane;k<n;k+=16u){dot+=s[u.a.x+k]*w[rowStart+k];}
    sums[lane]=dot;workgroupBarrier();
    for(var stride=8u;stride>0u;stride>>=1u){
        if(colLane<stride){sums[lane]+=sums[lane+stride];}
        workgroupBarrier();
    }
    if(colLane==0u){
        var result=sums[lane]+w[u.b.y+row];
        if(u.b.z==1u){result=gelu(result);}
        if(u.b.z==2u){result+=s[u.b.w+row];}
        s[u.a.y+row]=result;
    }
}
@compute @workgroup_size(64)
fn qk(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
    let h=group.y;let token=group.x*4u+lane/16u;let colLane=lane&15u;
    let q=u.a.x+h*64u;let key=u.a.y+token*512u+h*64u;
    var v=0.0;
    for(var k=colLane;k<64u;k+=16u){v+=s[q+k]*w[key+k];}
    sums[lane]=v;workgroupBarrier();
    for(var stride=8u;stride>0u;stride>>=1u){
        if(colLane<stride){sums[lane]+=sums[lane+stride];}
        workgroupBarrier();
    }
    if(colLane==0u){s[u.a.z+h*96u+token]=sums[lane]*0.125;}
}
@compute @workgroup_size(64)
fn softmax96(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
    let start=u.a.x+group.x*96u;
    var a=s[start+lane];var b=-3.402823e38;
    if(lane<32u){b=s[start+64u+lane];}
    sums[lane]=max(a,b);workgroupBarrier();
    for(var n=32u;n>0u;n>>=1u){
        if(lane<n){sums[lane]=max(sums[lane],sums[lane+n]);}
        workgroupBarrier();
    }
    let top=sums[0];
    workgroupBarrier(); // all lanes read the maximum before reusing sums
    a=exp(a-top);b=exp(b-top);
    sums[lane]=a+b;workgroupBarrier();
    for(var n=32u;n>0u;n>>=1u){
        if(lane<n){sums[lane]+=sums[lane+n];}
        workgroupBarrier();
    }
    let total=sums[0];
    s[start+lane]=a/total;
    if(lane<32u){s[start+64u+lane]=b/total;}
}
@compute @workgroup_size(64)
fn weighted(@builtin(global_invocation_id) gid:vec3u){
    let k=gid.x;let h=k/64u; var v=0.0;
    for(var t=0u;t<96u;t++){v+=s[u.a.x+h*96u+t]*w[u.a.y+t*512u+k];}
    s[u.a.z+k]=v;
}
