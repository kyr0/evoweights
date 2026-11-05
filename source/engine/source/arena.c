/* AGM PureDOOM host adapter. This translation unit links with the GPL-2.0 engine. */
#define DOOM_IMPLEMENTATION
#include "PureDOOM-instrumented.h"

__attribute__((import_module("host"),import_name("log"))) extern void arena_log(const char *);
__attribute__((import_module("host"),import_name("exit"))) extern void arena_exit(int);
extern unsigned char __heap_base;
static unsigned int bump;
static unsigned char *wad_data;
static int wad_size;
static int tick_count, last_action=-1;
static unsigned seed_state;
static float features[14];
static mobj_t *slots[5];
static int wait_tics[5];
static unsigned slot_life[5], spawn_serial;
static int prev_seen[5], previous_draw_tic;
static float prev_distance[5];
static int prev_life[5];
// Wall clearance is a known-map geometry sensor. Only living rendered pixels enable target sensors.
static float sensors[12];
static int hitscan_life;
// Populated from the final mask. Only visible living opponents yield coordinates.
static float visible_actors[5][7]; // id, worldX, worldY, screenX, range, closing, aligned
static float visible_yaw[5]; // same renderer-gated slots as visible_actors, world yaw in degrees
static float combat_state[12]; // weapon id, changing, idle-ready, health before/after/damage, event count, cumulative punches/hits/damage, forward steps/distance
static float attack_events[4][3]; // tick ending, kind (1 pistol/2 punch), target life id (0 miss)
static float damage_events[2]; // health lost during each of the two tics
static int attack_index=-1;

static void agm_attack_begin(int kind){
    int i=(int)combat_state[6];
    if(i>=4){attack_index=-1;return;}
    attack_events[i][0]=(float)(tick_count+1);
    attack_events[i][1]=(float)kind;
    attack_events[i][2]=0;
    combat_state[6]=i+1;
    attack_index=i;
    if(kind==2)combat_state[7]++;
}
static void agm_attack_end(void){attack_index=-1;}

static float telemetry[12]; // retreat commands, retreat command displacements, shots/nearest, multi-threat shots/nearest, traveled, kills of selected enemy
static int agm_slot_id(const void *m) {
    for(int i=0;i<5;i++)if(slots[i] && slots[i]==m)return i+1;
    return 0;
}
#ifdef AGM_BITE_AUDIT
// Offline test only. No actor attribution, range at strike, or phase is exported by the public build.
static int windup_tic[5], bite_count;
static float windup_range[5], bite_rows[5][6];
static float bite_range(mobj_t *actor) {
    return (float)P_AproxDistance(actor->target->x - actor->x, actor->target->y - actor->y)/FRACUNIT;
}
static void agm_bite_start(mobj_t *actor) {
    int slot=agm_slot_id(actor)-1;
    if(slot<0)return;
    windup_tic[slot]=tick_count+1;
    windup_range[slot]=bite_range(actor);
}
static void agm_bite_strike(mobj_t *actor, int health_before) {
    int slot=agm_slot_id(actor)-1;
    if(slot<0 || bite_count>=5)return;
    float *row=bite_rows[bite_count++];
    row[0]=(float)slot_life[slot];row[1]=(float)windup_tic[slot];row[2]=(float)(tick_count+1);
    row[3]=windup_range[slot];row[4]=bite_range(actor);row[5]=(float)(health_before-players[0].health);
}
int arena_bite_count(void){return bite_count;}
const float *arena_bites(void){return bite_rows[0];}
#endif
static void agm_player_hitscan(const void *m){
    int slot=agm_slot_id(m);
    if(!slot)return;
    hitscan_life=(int)slot_life[slot-1];
    if(attack_index>=0){
        attack_events[attack_index][2]=(float)hitscan_life;
        if(attack_events[attack_index][1]==2)combat_state[8]++;
    }
}
static float player_x(void){return (float)players[0].mo->x/FRACUNIT;}
static float player_y(void){return (float)players[0].mo->y/FRACUNIT;}
static float hypot2(float x,float y){return __builtin_sqrtf(x*x+y*y);}
static float rear_wall_clearance(void){
    mobj_t *pl=players[0].mo;
    int a=pl->angle >> ANGLETOFINESHIFT;
    float dx=-(float)finecosine[a]/FRACUNIT, dy=-(float)finesine[a]/FRACUNIT;
    float best=2048.f, px=player_x(), py=player_y(), rad=(float)pl->radius/FRACUNIT;
    // Convex 16-gon, clockwise linedefs. Compute the remaining ray length for
    // the player's axis-aligned collision box, not merely its center point.
    for(int j=0;j<numlines;j++){
        line_t*l=lines+j;
        float x=(float)l->v1->x/FRACUNIT,y=(float)l->v1->y/FRACUNIT;
        float ex=(float)l->dx/FRACUNIT,ey=(float)l->dy/FRACUNIT;
        float closing=ex*dy-ey*dx;
        if(closing<=0)continue;
        float side=ex*(py-y)-ey*(px-x);
        float remaining=(-side-rad*(__builtin_fabsf(ex)+__builtin_fabsf(ey)))/closing;
        if(remaining<best)best=remaining;
    }
    return best<0.f?0.f:best;
}


void *memcpy(void *o,const void *s,unsigned long n) { unsigned char *a=o;const unsigned char *b=s;for(unsigned long i=0;i<n;i++)a[i]=b[i];return o; }
void *memset(void *o,int v,unsigned long n) {unsigned char *a=o;for(unsigned long i=0;i<n;i++)a[i]=v;return o;}
void *memmove(void *o,const void *s,unsigned long n) {unsigned char *a=o;const unsigned char *b=s;if(a<=b)return memcpy(o,s,n);for(unsigned long i=n;i-->0;)a[i]=b[i];return o;}

static void *allocate(int n) {
    if(!bump) bump=(unsigned)&__heap_base;
    if(n<0||n>48*1024*1024)arena_exit(80);
    bump=(bump+15)&~15u;unsigned start=bump;bump+=(unsigned)n;
    if(bump>=__builtin_wasm_memory_size(0)*65536u)arena_exit(81);
    return (void*)start;
}
static void release(void *unused) {(void)unused;}
typedef struct {int used,pos;} File;
static File files[24];
static void* open_file(const char* n,const char *mode){
    const char *base=n;
    for(const char *p=n;*p;p++)if(*p=='/'||*p=='\\')base=p+1;
    if(mode[0]!='r'||doom_strcmp(base,"doom2.wad"))return 0;
    for(int i=0;i<24;i++)if(!files[i].used){files[i].used=1;files[i].pos=0;return files+i;}
    return 0;
}
static void close_file(void* h){((File*)h)->used=0;}
static int read_file(void* h,void* dst,int n){File*f=h;if(f->pos+n>wad_size)n=wad_size-f->pos;if(n<0)return 0;memcpy(dst,wad_data+f->pos,n);f->pos+=n;return n;}
static int write_file(void*h,const void*s,int n){(void)h;(void)s;(void)n;return 0;}
static int seek_file(void*h,int v,doom_seek_t whence){File*f=h;int p=whence==DOOM_SEEK_SET?v:whence==DOOM_SEEK_CUR?f->pos+v:wad_size+v;if(p<0||p>wad_size)return -1;f->pos=p;return 0;}
static int tell_file(void*h){return ((File*)h)->pos;}
static int eof_file(void*h){return ((File*)h)->pos>=wad_size;}
static void game_clock(int*s,int*u){*s=1+tick_count/35;*u=tick_count%35*1000000/35;}
static char *environment(const char*k){(void)k;return ".";}

static unsigned rng(void){seed_state=seed_state*1664525u+1013904223u;return seed_state;}
static void spawn_opponent(int i,int angle) {
    int idx=angle&(FINEANGLES-1);
    mobj_t *mo=P_SpawnMobj(735*finecosine[idx],735*finesine[idx],ONFLOORZ,MT_SERGEANT);
    mo->health=1;mo->angle=(angle_t)idx*(1u<<ANGLETOFINESHIFT)+ANG180;
    mo->target=players[0].mo;
    P_SetMobjState(mo,mo->info->seestate);
    slots[i]=mo;slot_life[i]=++spawn_serial;wait_tics[i]=0;
}
static void draw(void){
    memset(agm_mask,0,sizeof(agm_mask));
    wipegamestate=gamestate;
    D_Display();
    const int width=SCREENWIDTH,height=SCREENHEIGHT;
    int left=0, count[5]={0}, center[5]={0},xsum[5]={0};
    const int cx=width/2, strip=4;
    for(int k=0;k<9;k++){
        int w=width/9+(k<width%9),sum=0;
        for(int y=0;y<height;y++)for(int x=left;x<left+w;x++){
            int id=agm_mask[y*width+x];
            if(id){
                sum++;count[id-1]++;xsum[id-1]+=x;
                if(x>=cx-strip && x<=cx+strip)center[id-1]++;
            }
        }
        features[k]=(float)sum/(float)(height*w);left+=w;
    }
    memset(visible_actors,0,sizeof(visible_actors));
    memset(visible_yaw,0,sizeof(visible_yaw));
    player_t *pl=&players[0];
    weaponinfo_t *wi=&weaponinfo[pl->readyweapon];
    state_t *ps=pl->psprites[ps_weapon].state;
    combat_state[0]=(float)pl->readyweapon;
    combat_state[1]=(pl->pendingweapon!=wp_nochange || ps==&states[wi->upstate] || ps==&states[wi->downstate]);
    combat_state[2]=(pl->health>0 && !combat_state[1] && ps==&states[wi->readystate] &&
                     (wi->ammo==am_noammo || pl->ammo[wi->ammo]>0));
    memset(sensors,0,sizeof(sensors));
    sensors[5]=rear_wall_clearance();sensors[8]=player_x();sensors[9]=player_y();
    sensors[10]=(float)((double)players[0].mo->angle*(360.0/4294967296.0));
    int elapsed=tick_count-previous_draw_tic;
    for(int i=0;i<5;i++){
        if(!count[i] || !slots[i] || slots[i]->health<=0){prev_seen[i]=0;continue;}
        sensors[7]++;
        float dx=(float)slots[i]->x/FRACUNIT-sensors[8],dy=(float)slots[i]->y/FRACUNIT-sensors[9];
        float distance=hypot2(dx,dy);
        float speed=(elapsed>0 && prev_seen[i] && prev_life[i]==(int)slot_life[i])?(prev_distance[i]-distance)/elapsed:0.f;
        float *v=visible_actors[i];
        visible_yaw[i]=(float)((double)slots[i]->angle*(360.0/4294967296.0));
        v[0]=(float)slot_life[i];v[1]=(float)slots[i]->x/FRACUNIT;v[2]=(float)slots[i]->y/FRACUNIT;
        v[3]=2.f*((float)xsum[i]/count[i]+.5f)/width-1.f;v[4]=distance;
        v[5]=speed;v[6]=(center[i]>0);
        if(!sensors[0] || distance<sensors[2]){
            sensors[0]=1;
            sensors[1]=2.f*((float)xsum[i]/count[i]+.5f)/width-1.f;
            sensors[2]=distance;sensors[3]=speed;sensors[4]=(center[i]>0);
            sensors[6]=(float)slot_life[i];sensors[11]=i+1;
        }
        prev_seen[i]=1;prev_life[i]=(int)slot_life[i];prev_distance[i]=distance;
    }
    previous_draw_tic=tick_count;
    features[9]=(float)players[0].ammo[am_clip];features[10]=(float)players[0].health;
    for(int k=0;k<3;k++)features[11+k]=k==last_action?1.f:0.f;
}
unsigned int arena_wad(int n){wad_size=n;wad_data=allocate(n);return (unsigned int)wad_data;}
void arena_start(unsigned int seed){
    char *args[]={"agm","-warp","1","-skill","3",0};
    doom_set_malloc(allocate,release);doom_set_print(arena_log);doom_set_exit(arena_exit);
    doom_set_file_io(open_file,close_file,read_file,write_file,seek_file,tell_file,eof_file);
    doom_set_gettime(game_clock);doom_set_getenv(environment);
    doom_set_default_int("screenblocks",11);doom_set_default_int("detaillevel",0);
    doom_init(5,args,7);G_InitNew(sk_medium,1,1);gameaction=ga_nothing;advancedemo=false;
    seed_state=seed;prndindex=(rng()>>16)&255;rndindex=(rng()>>16)&255;
    players[0].ammo[am_clip]=26;
    int rotation=(rng()>>16)&(FINEANGLES-1);
    for(int i=0;i<5;i++)spawn_opponent(i,rotation+i*FINEANGLES/5);
    R_SetViewSize(11,0);
    // Warm pistol presentation and the ticking world before the first observation.
    for(int j=0;j<10;j++){ticcmd_t *c=&netcmds[0][(gametic/ticdup)%BACKUPTICS];memset(c,0,sizeof(*c));G_Ticker();gametic++;maketic++;}
    tick_count=0;last_action=-1;
    memset(combat_state,0,sizeof(combat_state));
    combat_state[3]=combat_state[4]=(float)players[0].health;
    draw();
}
/* Episode length in tics (35 per second). 2100 reproduces the one-minute cap of every published result; 0 removes the cap for human and spectator play. */
static int tick_limit=2100;
void arena_set_limit(int tics){tick_limit=tics>0?tics:0;}
int arena_limit(void){return tick_limit;}
int arena_done(void){return players[0].health<=0 || (tick_limit>0 && tick_count>=tick_limit);}
void arena_step(int act,int backward,int forward){
    if(act<0||act>3||arena_done())return;
#ifdef AGM_BITE_AUDIT
    bite_count=0;
#endif
    float x0=player_x(),y0=player_y();
    int before_ammo=players[0].ammo[am_clip], nearest_slot=(int)sensors[11]-1;
    unsigned nearest_life=(unsigned)sensors[6];
    int aligned=(int)sensors[4],visible_count=(int)sensors[7];
    hitscan_life=0;last_action=act;
    combat_state[3]=(float)players[0].health;combat_state[5]=combat_state[6]=0;
    damage_events[0]=damage_events[1]=0;attack_index=-1;
    for(int j=0;j<2 && !arena_done();j++){
        ticcmd_t *c=&netcmds[0][(gametic/ticdup)%BACKUPTICS];memset(c,0,sizeof(*c));
        c->angleturn=act==0?512:act==1?-512:0;c->buttons=act==2?BT_ATTACK:0;c->forwardmove=backward?-25:forward?25:0;
        int before_health=players[0].health;
        G_Ticker();gametic++;maketic++;tick_count++;
        int delta=before_health-players[0].health;
        if(delta>0){damage_events[j]=(float)delta;combat_state[5]+=delta;combat_state[9]+=delta;}
        for(int i=0;i<5;i++){
            if(slots[i] && slots[i]->health<=0){
                if(i==nearest_slot && slot_life[i]==nearest_life)telemetry[7]++;
                slots[i]=0;wait_tics[i]=90;}
            else if(!slots[i] && --wait_tics[i]<=0)spawn_opponent(i,(rng()>>16)&(FINEANGLES-1));
        }
    }
    float displacement=hypot2(player_x()-x0,player_y()-y0);
    combat_state[4]=(float)players[0].health;
    if(forward){combat_state[10]++;combat_state[11]+=displacement;}
    telemetry[6]+=displacement;
    if(backward){telemetry[0]++;telemetry[1]+=displacement;}
    int shots=before_ammo-players[0].ammo[am_clip];
    if(shots>0){
        if(hitscan_life){
            telemetry[8]++;
            if((unsigned)hitscan_life==nearest_life){
                telemetry[9]++;
                if(visible_count>=2)telemetry[11]++;
            }
            if(visible_count>=2)telemetry[10]++;
        }
        telemetry[2]+=shots;telemetry[3]+=shots*aligned;
        if(visible_count>=2){telemetry[4]+=shots;telemetry[5]+=shots*aligned;}
    }
    draw();
}
const float *arena_visible(void){return visible_actors[0];}
const float *arena_visible_yaw(void){return visible_yaw;}
const float *arena_combat(void){return combat_state;}
const float *arena_attacks(void){return attack_events[0];}
const float *arena_damages(void){return damage_events;}
const float *arena_sensors(void){return sensors;}
const float *arena_telemetry(void){return telemetry;}
const unsigned char *arena_frame(void){return doom_get_framebuffer(4);}
const float *arena_features(void){return features;}
int arena_kills(void){return players[0].killcount;}
int arena_tic(void){return tick_count;}
