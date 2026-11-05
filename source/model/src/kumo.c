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
static float normed[512], qv[512], av[512], att[512], mlp[1024], scores[128], gate[64], feature[3][64];
static float kv_pair[2 * 128];
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
static void attention_row(float *target,const Block *b,int d,int heads,int key_len,int pos,
                          const float *K,const float *V) {
    int hd=d/heads;
    rms(target,normed,d,b->nq,1.1920928955078125e-7f);
    linear(b->q,normed,qv,d,d);
    transform_heads(qv,hd,heads,pos,b->rope);
    for(int h=0;h<heads;h++) {
        float *q=qv+h*hd;
        if(b->gate1.weight) {
            linear(b->gate1,q,gate,hd,64);
            for(int i=0;i<64;i++) gate[i]=gelu(gate[i]);
            linear(b->gate2,gate,av,64,hd);
            for(int i=0;i<hd;i++) q[i]*=(1+math_tanh(av[i]))*data[b->scale+h];
        }else if(b->scale) {
            float s=data[b->scale+h];
            for(int i=0;i<hd;i++) q[i]*=s;
        }
        float high=-3.40282346e38f;
        float inv=1.0f/__builtin_sqrtf((float)hd);
        for(int i=0;i<key_len;i++) {
            float a=dot(q,K+i*d+h*hd,hd)*inv;
            scores[i]=a;
            if(a>high) high=a;
        }
        float sum=0;
        for(int i=0;i<key_len;i++) {
            scores[i]=math_exp(scores[i]-high);
            sum+=scores[i];
        }
        float *res=att+h*hd;
        for(int k=0;k<hd;k++) res[k]=0;
        for(int i=0;i<key_len;i++) {
            float coeff=scores[i]/sum;
            const float *v=V+i*d+h*hd;
            for(int k=0;k<hd;k++)res[k]+=coeff*v[k];
        }
    }
    linear(b->out,att,av,d,d);
    for(int j=0;j<d;j++) target[j]+=av[j];
    rms(target,normed,d,b->nm,1.1920928955078125e-7f);
    linear(b->mlp1,normed,mlp,d,2*d);
    for(int j=0;j<2*d;j++) mlp[j]=gelu(mlp[j]);
    linear(b->mlp2,mlp,av,2*d,d);
    for(int j=0;j<d;j++) target[j]+=av[j];
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
unsigned state_ptr(void){return (unsigned)(uintptr_t)state;}
unsigned hidden_ptr(void){return (unsigned)(uintptr_t)hidden;}
void finish_for_gpu(void){ linear(HEAD2,hidden,logits,1024,3); }
void encode_for_gpu(void) {
    embed();
    for(int layer=0;layer<4;layer++) {
        const Block *c=&col[layer], *r=&row[layer];
        for(int t=0;t<14;t++) {
            attention_row(tokens[t+4],c,128,4,128,0,data+c->key+t*128*128,data+c->value+t*128*128);
        }
        for(int t=0;t<18;t++) {
            rms(tokens[t],normed,128,r->nk,1.1920928955078125e-7f);
            linear(r->kv,normed,kv_pair,128,256);
            __builtin_memcpy(keys+t*128,kv_pair,128*sizeof(float));
            __builtin_memcpy(vals+t*128,kv_pair+128,128*sizeof(float));
            transform_heads(keys+t*128,32,4,t,r->rope);
        }
        for(int t=0;t<(layer==3?4:18);t++)
            attention_row(tokens[t],r,128,4,18,t,keys,vals);
    }
    for(int t=0;t<4;t++)
        rms(tokens[t],state+t*128,128,ROW_NORM,1.1920928955078125e-7f);
}
void infer(void) {
    encode_for_gpu();
    for(int j=0;j<12;j++)
        attention_row(state,&icl[j],512,8,96,0,data+icl[j].key,data+icl[j].value);
    rms(state,normed,512,ICL_NORM,1.1920928955078125e-7f);
    linear(HEAD1,normed,hidden,512,1024);
    for(int j=0;j<1024;j++) hidden[j]=gelu(hidden[j]);
    linear(HEAD2,hidden,logits,1024,3);
}
