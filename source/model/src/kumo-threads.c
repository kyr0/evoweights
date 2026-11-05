/* Kumo Small one-query specialization. Offsets and cached keys/values are exported
   from the real PyTorch checkpoint. Each browser session owns its own instance. */
#include <stdint.h>
#include <stddef.h>
typedef float vec4 __attribute__((vector_size(16)));
typedef struct { unsigned weight, bias; } Linear;
typedef struct {
    Linear q, kv, out, mlp1, mlp2, gate1, gate2;
    unsigned nq, nk, nm, key, value, scale, rope;
} Block;
#include "layout.h"
__attribute__((import_module("math"),import_name("exp"))) extern float math_exp(float);
__attribute__((import_module("math"),import_name("tanh"))) extern float math_tanh(float);
__attribute__((import_module("math"),import_name("sin"))) extern float math_sin(float);
__attribute__((import_module("math"),import_name("cos"))) extern float math_cos(float);

static float data[TOTAL_FLOATS] __attribute__((aligned(16)));
static float observation[14], logits[3], hidden[1024];
static float tokens[18][128], state[512], keys[18 * 128], vals[18 * 128];
enum { MAX_LANES=8, LANE_STACK_BYTES=65536 };
unsigned max_lanes(void){return MAX_LANES;}
unsigned lane_stack_bytes(void){return LANE_STACK_BYTES;}
typedef struct {
    float normed[512], qv[512], av[512], att[512], mlp[1024], scores[128], gate[64], kv_pair[256];
} Scratch;
static Scratch private_ws[MAX_LANES] __attribute__((aligned(64)));
static Scratch global_ws __attribute__((aligned(64)));
static float feature[3][64];

static inline vec4 vload(const float *p) {
    vec4 v;
    __builtin_memcpy(&v,p,sizeof(v));
    return v;
}
static inline float dot(const float *a,const float *b,int n) {
    vec4 x={0}, y={0}, z={0}, w={0};
    for (int i=0;i<n;i+=16) {
        x+=vload(a+i)*vload(b+i); y+=vload(a+i+4)*vload(b+i+4);
        z+=vload(a+i+8)*vload(b+i+8); w+=vload(a+i+12)*vload(b+i+12);
    }
    vec4 s=(x+y)+(z+w);
    return (s[0]+s[1])+(s[2]+s[3]);
}
static void linear(Linear weights,const float *x,float *out,int n,int m) {
    const float *W=data+weights.weight, *b=data+weights.bias;
    for(int j=0;j<m;++j) out[j]=b[j]+dot(x,W+(size_t)j*n,n);
}
static void rms(const float *x,float *out,int n,unsigned offset,float eps) {
    float r=1.0f/__builtin_sqrtf(dot(x,x,n)/n+eps);
    if(offset) for(int j=0;j<n;++j) out[j]=x[j]*r*data[offset+j];
    else for(int j=0;j<n;++j) out[j]=x[j]*r;
}
static inline float gelu(float x) {
    /* Abramowitz/Stegun 7.1.26, erf(max error ~1.5e-7). */
    if(x>7) return x;
    if(x<-7) return 0;
    float u=__builtin_fabsf(x)*0.7071067811865475f;
    float t=1.0f/(1.0f+0.3275911f*u);
    float poly=(((((1.061405429f*t-1.453152027f)*t)+1.421413741f)*t-0.284496736f)*t+0.254829592f)*t;
    float erf=1.0f-poly*math_exp(-u*u);
    return 0.5f*x*(1.0f+(x<0?-erf:erf));
}
static void transform_heads(float *x,int length,int heads,int pos,unsigned rope) {
    for(int h=0;h<heads;h++) {
        float *v=x+h*length;
        if(rope) {
            const float *c=data+rope+pos*length, *s=c+length/2;
            for(int k=0;k<length/2;k++){
                float a=v[k],b=v[k+length/2];
                v[k]=a*c[k]-b*s[k];v[k+length/2]=b*c[k]+a*s[k];
            }
        }
        rms(v,v,length,0,1e-6f);
    }
}
static void attention_row(Scratch *scratch,float *target,const Block *b,int d,int heads,int key_len,int pos,
                          const float *K,const float *V) {
    int hd=d/heads;
    rms(target,scratch->normed,d,b->nq,1.1920928955078125e-7f);
    linear(b->q,scratch->normed,scratch->qv,d,d);
    transform_heads(scratch->qv,hd,heads,pos,b->rope);
    for(int h=0;h<heads;h++) {
        float *q=scratch->qv+h*hd;
        if(b->gate1.weight) {
            linear(b->gate1,q,scratch->gate,hd,64);
            for(int i=0;i<64;i++) scratch->gate[i]=gelu(scratch->gate[i]);
            linear(b->gate2,scratch->gate,scratch->av,64,hd);
            for(int i=0;i<hd;i++) q[i]*=(1+math_tanh(scratch->av[i]))*data[b->scale+h];
        }else if(b->scale) {
            float s=data[b->scale+h];
            for(int i=0;i<hd;i++) q[i]*=s;
        }
        float high=-3.40282346e38f;
        float inv=1.0f/__builtin_sqrtf((float)hd);
        for(int i=0;i<key_len;i++) {
            float a=dot(q,K+i*d+h*hd,hd)*inv;
            scratch->scores[i]=a;
            if(a>high) high=a;
        }
        float sum=0;
        for(int i=0;i<key_len;i++) {
            scratch->scores[i]=math_exp(scratch->scores[i]-high);
            sum+=scratch->scores[i];
        }
        float *res=scratch->att+h*hd;
        for(int k=0;k<hd;k++) res[k]=0;
        for(int i=0;i<key_len;i++) {
            float coeff=scratch->scores[i]/sum;
            const float *v=V+i*d+h*hd;
            for(int k=0;k<hd;k++)res[k]+=coeff*v[k];
        }
    }
    linear(b->out,scratch->att,scratch->av,d,d);
    for(int j=0;j<d;j++) target[j]+=scratch->av[j];
    rms(target,scratch->normed,d,b->nm,1.1920928955078125e-7f);
    linear(b->mlp1,scratch->normed,scratch->mlp,d,2*d);
    for(int j=0;j<2*d;j++) scratch->mlp[j]=gelu(scratch->mlp[j]);
    linear(b->mlp2,scratch->mlp,scratch->av,2*d,d);
    for(int j=0;j<d;j++) target[j]+=scratch->av[j];
}
static void embed(void) {
    for(int c=0;c<14;c++) {
        float v=(observation[c]-data[MEAN+c])/data[STD+c];
        observation[c]=(v < -5 ? -5 : v > 5 ? 5 : v);
    }
    __builtin_memcpy(tokens,data+READOUT,4*128*sizeof(float));
    for(int c=0;c<14;c++) {
        for(int g=0;g<3;g++) {
            float x=observation[(c+(1<<g)-1)%14];
            for(int k=0;k<32;k++) {
                float a=x*data[FREQ+32*g+k];
                feature[g][k]=math_sin(a);
                feature[g][32+k]=math_cos(a);
            }
        }
        for(int d=0;d<128;d++) {
            const float *row_w=data+CELL_WEIGHT+64*d;
            tokens[4+c][d]=3.0f*data[CELL_BIAS+d]+dot(feature[0],row_w,64)
                +dot(feature[1],row_w,64)+dot(feature[2],row_w,64);
        }
    }
}
unsigned input_ptr(void){return (unsigned)(uintptr_t)observation;}
unsigned data_ptr(void){return (unsigned)(uintptr_t)data;}
unsigned logits_ptr(void){return (unsigned)(uintptr_t)logits;}
unsigned data_size(void){return TOTAL_FLOATS;}
/* The model, cache, observations and results are shared. Each WASM instance has a
   private stack; a lane owns a distinct scratch record. One caller drives the network. */
/* One cache line per lane. Diagnostics count completed inference passes and actual
   attention-row calls made in the last encoder pass. Never used by the policy. */
typedef struct { unsigned passes, rows; unsigned padding[14]; } LaneStat;
static LaneStat lane_stats[MAX_LANES] __attribute__((aligned(64)));
unsigned lane_stat(int lane,int which) {
    if(lane<0||lane>=MAX_LANES||(which!=0&&which!=1))__builtin_trap();
    return which==0 ? __atomic_load_n(&lane_stats[lane].passes,__ATOMIC_RELAXED)
                    : __atomic_load_n(&lane_stats[lane].rows,__ATOMIC_RELAXED);
}
static int ticket __attribute__((aligned(64)));
static int arrived __attribute__((aligned(64)));
static int phase __attribute__((aligned(64)));
unsigned ticket_ptr(void){return (unsigned)(uintptr_t)&ticket;}

static void barrier(int n) {
    if(n==1) return;
    const int expected=__atomic_load_n(&phase,__ATOMIC_ACQUIRE);
    if(__atomic_fetch_add(&arrived,1,__ATOMIC_ACQ_REL)==n-1) {
        __atomic_store_n(&arrived,0,__ATOMIC_RELAXED);
        __atomic_fetch_add(&phase,1,__ATOMIC_RELEASE);
        __builtin_wasm_memory_atomic_notify(&phase,n-1);
        return;
    }
    for(int i=0;i<96;i++)
        if(__atomic_load_n(&phase,__ATOMIC_ACQUIRE)!=expected) return;
    while(__atomic_load_n(&phase,__ATOMIC_ACQUIRE)==expected)
        if(__builtin_wasm_memory_atomic_wait32(&phase,expected,5000000000LL)==2)
            __builtin_trap();
}
static inline void linear_range(Linear l,const float *x,float *out,int n,int start,int end){
    const float *W=data+l.weight,*b=data+l.bias;
    for(int j=start;j<end;j++) out[j]=b[j]+dot(x,W+(size_t)j*n,n);
}

static void icl_layer(const Block *b,int lane,int n) {
    Scratch *s=&global_ws;
    const int d=512,heads=8,hd=64,key_len=96;
    const int a=lane*d/n,z=(lane+1)*d/n;
    if(lane==0)rms(state,s->normed,d,b->nq,1.1920928955078125e-7f);
    barrier(n);
    linear_range(b->q,s->normed,s->qv,d,a,z);
    barrier(n);
    float *score=private_ws[lane].scores;
    for(int h=lane;h<heads;h+=n) {
        float *q=s->qv+h*hd,*target=s->att+h*hd;
        rms(q,q,hd,0,1e-6f);
        for(int j=0;j<hd;j++)q[j]*=data[b->scale+h];
        float high=-3.40282346e38f;
        for(int i=0;i<key_len;i++){
            score[i]=dot(q,data+b->key+i*d+h*hd,hd)*0.125f;
            if(score[i]>high)high=score[i];
        }
        float sum=0;
        for(int i=0;i<key_len;i++){score[i]=math_exp(score[i]-high);sum+=score[i];}
        for(int j=0;j<hd;j++)target[j]=0;
        for(int i=0;i<key_len;i++){
            const float c=score[i]/sum,*v=data+b->value+i*d+h*hd;
            for(int j=0;j<hd;j++)target[j]+=c*v[j];
        }
    }
    barrier(n);
    linear_range(b->out,s->att,s->av,d,a,z);
    for(int j=a;j<z;j++)state[j]+=s->av[j];
    barrier(n);
    if(lane==0)rms(state,s->normed,d,b->nm,1.1920928955078125e-7f);
    barrier(n);
    linear_range(b->mlp1,s->normed,s->mlp,d,2*a,2*z);
    for(int j=2*a;j<2*z;j++)s->mlp[j]=gelu(s->mlp[j]);
    barrier(n);
    linear_range(b->mlp2,s->mlp,s->av,2*d,a,z);
    for(int j=a;j<z;j++)state[j]+=s->av[j];
    barrier(n);
}

void run_lane(int lane,int n) {
    if(n<1||n>MAX_LANES||lane<0||lane>=n)__builtin_trap();
    Scratch *s=&private_ws[lane];
    unsigned rows_done=0;
    if(lane==0)embed();
    barrier(n);
    for(int layer=0;layer<4;layer++) {
        const Block *c=&col[layer],*r=&row[layer];
        for(int t=lane;t<14;t+=n){
            attention_row(s,tokens[t+4],c,128,4,128,0,data+c->key+t*128*128,data+c->value+t*128*128);
            rows_done++;
        }
        barrier(n);
        for(int t=lane;t<18;t+=n) {
            rms(tokens[t],s->normed,128,r->nk,1.1920928955078125e-7f);
            linear(r->kv,s->normed,s->kv_pair,128,256);
            __builtin_memcpy(keys+t*128,s->kv_pair,128*sizeof(float));
            __builtin_memcpy(vals+t*128,s->kv_pair+128,128*sizeof(float));
            transform_heads(keys+t*128,32,4,t,r->rope);
        }
        barrier(n);
        const int rows=layer==3?4:18;
        for(int t=lane;t<rows;t+=n){
            attention_row(s,tokens[t],r,128,4,18,t,keys,vals);
            rows_done++;
        }
        barrier(n);
    }
    if(lane==0)for(int t=0;t<4;t++)
        rms(tokens[t],state+t*128,128,ROW_NORM,1.1920928955078125e-7f);
    barrier(n);
    for(int j=0;j<12;j++) icl_layer(&icl[j],lane,n);
    if(lane==0) {
        rms(state,s->normed,512,ICL_NORM,1.1920928955078125e-7f);
        linear(HEAD1,s->normed,hidden,512,1024);
        for(int j=0;j<1024;j++)hidden[j]=gelu(hidden[j]);
        linear(HEAD2,hidden,logits,1024,3);
    }
    __atomic_store_n(&lane_stats[lane].rows,rows_done,__ATOMIC_RELAXED);
    __atomic_fetch_add(&lane_stats[lane].passes,1,__ATOMIC_RELAXED);
    barrier(n);
}
void infer_main(int n) {
    if(n<1||n>MAX_LANES)__builtin_trap();
    if(n>1){__atomic_fetch_add(&ticket,1,__ATOMIC_RELEASE);__builtin_wasm_memory_atomic_notify(&ticket,n-1);}
    run_lane(0,n);
}
