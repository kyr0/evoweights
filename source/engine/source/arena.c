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

/* Versioned HuggingDOOM rules. Legacy weapon/feature names remain the policy
 * ABI; no ordinary Doom player damage or enemy death reaches the renderer. */
enum { PICNIC_CAP = 256, HUG_TICS = 24, BITE_GRACE_TICS = 24, FINALE_TICS = 70 };
typedef struct { mobj_t *bear; int kind, born; } picnic_bear_t;
static picnic_bear_t picnic_bears[PICNIC_CAP];
static int picnic_count, picnic_next, fed_count, friend_count, bitten_count;
static int hug_until, bite_until, dizzy_until, ending_at = -1;
static float picnic_state[11];
static mobj_t *flowers[80];
static int cartoon_health(void) { return 100 - bitten_count * 20; }
static int agm_action_locked(void) { return ending_at >= 0 || tick_count < hug_until; }
static void make_peaceful(mobj_t *bear, int kind);

static int agm_cartoon_damage(mobj_t *target) {
    if (target != players[0].mo) return 0;
    /* A completed hug reserves personal space; impatient neighbours wait.
     * A bite has a fixed cost and a grace period, even with five neighbours. */
    if (ending_at >= 0 || tick_count < hug_until || tick_count < bite_until) return 1;
    bitten_count++;
    bite_until = tick_count + BITE_GRACE_TICS;
    dizzy_until = tick_count + 18;
    int health = cartoon_health();
    players[0].health = target->health = health > 0 ? health : 1;
    /* Use Doom's fading damage palette without moving the player's view. */
    players[0].damagecount = 20;
    players[0].bonuscount = 0;
    if (!health) ending_at = tick_count + 1;
    return 1;
}

static int agm_wait_for_hug(mobj_t *actor) {
    if (actor->type != MT_SERGEANT || actor->target != players[0].mo) return 0;
    if (ending_at < 0 && tick_count >= hug_until) return 0;
    if (ending_at < 0 && P_AproxDistance(actor->x - players[0].mo->x,
                                       actor->y - players[0].mo->y) > 150 * FRACUNIT) return 0;
    actor->frame = (tick_count/6)%2 ? 7 : 3; /* H/D: the impatient foot tap. */
    actor->momx = actor->momy = 0;
    A_FaceTarget(actor);
    return 1;
}

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
        int kind=(int)attack_events[attack_index][1];
        if(kind==1 || kind==2)make_peaceful((mobj_t *)m,kind);
    }
}

static void make_peaceful(mobj_t *bear, int kind) {
    if (bear->health <= 0) return;
    bear->health = 0;
    bear->flags &= ~(MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL | MF_JUSTATTACKED);
    bear->flags |= MF_CORPSE | MF_NOBLOOD;
    bear->momx = bear->momy = bear->momz = 0;
    bear->target = 0;
    bear->state = &states[S_SARG_DIE6];
    bear->sprite = SPR_SARG;
    bear->frame = kind == 1 ? 8 : 11;
    bear->tics = -1;
    if (picnic_count == PICNIC_CAP) P_RemoveMobj(picnic_bears[picnic_next].bear);
    else picnic_count++;
    picnic_bears[picnic_next] = (picnic_bear_t){bear, kind, tick_count + 1};
    picnic_next = (picnic_next + 1) % PICNIC_CAP;
    if (kind == 1) fed_count++;
    else {
        friend_count++; hug_until = tick_count + 1 + HUG_TICS;
        /* Hold the embrace in place instead of coasting through the bear. */
        players[0].mo->momx = players[0].mo->momy = 0;
    }
    players[0].killcount = fed_count + friend_count;
    if (kind == 2) for (int i=0; i<80; i++) {
        mobj_t *flower=flowers[i];
        fixed_t dx=flower->x-bear->x,dy=flower->y-bear->y;
        fixed_t distance=P_AproxDistance(dx,dy);
        if(distance>0 && distance<110*FRACUNIT) {
            /* The oversized heart gently nudges nearby flowers, never bodies. */
            flower->momx=FixedMul(FixedDiv(dx,distance),FRACUNIT/2);
            flower->momy=FixedMul(FixedDiv(dy,distance),FRACUNIT/2);
        }
    }
}

static void gather_bear(mobj_t *bear, int angle, int radius) {
    mobj_t *pl=players[0].mo;
    int a=((pl->angle >> ANGLETOFINESHIFT)+angle)&(FINEANGLES-1);
    fixed_t x=pl->x+radius*finecosine[a], y=pl->y+radius*finesine[a];
    /* The known convex arena contains this conservative inner circle. */
    fixed_t center_distance=P_AproxDistance(x,y);
    if(center_distance>740*FRACUNIT) {
        fixed_t scale=FixedDiv(740*FRACUNIT,center_distance);
        x=FixedMul(x,scale);y=FixedMul(y,scale);
    }
    int remain=FINALE_TICS-(tick_count-ending_at);
    if(remain<1)remain=1;
    bear->flags &= ~(MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL);
    P_UnsetThingPosition(bear);
    bear->x+=(x-bear->x)/remain;bear->y+=(y-bear->y)/remain;
    P_SetThingPosition(bear);
    bear->momx=bear->momy=0;bear->tics=-1;
    bear->angle=R_PointToAngle2(bear->x,bear->y,pl->x,pl->y);
}

static void update_picnic(void) {
    for (int i=0; i<picnic_count; i++) {
        picnic_bear_t *p = picnic_bears + i;
        int age = tick_count - p->born;
        p->bear->frame = p->kind == 1 ? (age < 8 ? 8 : 9 + (i % 2))
                                     : (age < HUG_TICS ? 11 : 12 + (age / 24) % 2);
    }
    if (ending_at >= 0) {
        /* Retained guests also join the harmless gathering, arranged behind
         * the active bears in staggered rows rather than one overlapping pile. */
        for(int i=0;i<picnic_count;i++) {
            int column=i%9,row=i/9;
            gather_bear(picnic_bears[i].bear,(column-4)*300+(row%2)*150,
                        180+(row<8?row:8)*35);
            if(tick_count-ending_at<FINALE_TICS-12)
                picnic_bears[i].bear->frame=((tick_count+i*2)/5)%4;
        }
        /* A broad semicircle stays in front; its centre guest finds the
         * emergency honey (O). No attack or death thinkers run. */
        int live_count=0,rank=0;
        for(int i=0;i<5;i++)if(slots[i] && slots[i]->health>0)live_count++;
        for (int i=0; i<5; i++) if (slots[i] && slots[i]->health > 0) {
            mobj_t *bear=slots[i];
            gather_bear(bear,(rank*2-(live_count-1))*240,110);
            bear->frame=tick_count-ending_at>FINALE_TICS-12?
                        (rank==live_count/2?14:9):(tick_count/5)%4;
            rank++;
        }
    }
    picnic_state[0]=(float)fed_count;picnic_state[1]=(float)friend_count;
    picnic_state[2]=(float)bitten_count;picnic_state[3]=(float)(5-bitten_count);
    picnic_state[4]=tick_count<hug_until;picnic_state[5]=ending_at>=0;
    picnic_state[6]=players[0].ammo[am_clip]==0 && players[0].readyweapon!=wp_fist;
    picnic_state[7]=(float)picnic_count;
    picnic_state[8]=ending_at<0?0.f:(float)(tick_count-ending_at)/FINALE_TICS;
    picnic_state[9]=tick_count<dizzy_until;
    picnic_state[10]=(float)(ending_at>=0?ending_at:tick_count);
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
    mo->flags |= MF_NOBLOOD;
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
    combat_state[2]=(!agm_action_locked() && pl->health>0 && !combat_state[1] && ps==&states[wi->readystate] &&
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
    features[9]=(float)players[0].ammo[am_clip];features[10]=(float)cartoon_health();
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
    /* Fixed ornamental placement consumes no gameplay PRNG values. */
    for(int i=0;i<80;i++) {
        int a=(i*3131)&(FINEANGLES-1),r=150+(i*83)%530;
        mobj_t *flower=P_SpawnMobj(r*finecosine[a],r*finesine[a],ONFLOORZ,MT_MISC31);
        flower->flags &= ~(MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL | MF_SPECIAL);
        flowers[i]=flower;
    }
    R_SetViewSize(11,0);
    // Warm pistol presentation and the ticking world before the first observation.
    for(int j=0;j<10;j++){ticcmd_t *c=&netcmds[0][(gametic/ticdup)%BACKUPTICS];memset(c,0,sizeof(*c));G_Ticker();gametic++;maketic++;}
    tick_count=0;last_action=-1;
    memset(combat_state,0,sizeof(combat_state));
    combat_state[3]=combat_state[4]=(float)players[0].health;
    update_picnic();
    draw();
}
/* Episode length in tics (35 per second). 2100 reproduces the one-minute cap of every published result; 0 removes the cap for human and spectator play. */
static int tick_limit=2100;
void arena_set_limit(int tics){tick_limit=tics>0?tics:0;}
int arena_limit(void){return tick_limit;}
int arena_done(void){return (ending_at>=0 && tick_count-ending_at>=FINALE_TICS) ||
                           (ending_at<0 && tick_limit>0 && tick_count>=tick_limit);}
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
    combat_state[3]=(float)cartoon_health();combat_state[5]=combat_state[6]=0;
    damage_events[0]=damage_events[1]=0;attack_index=-1;
    for(int j=0;j<2 && !arena_done();j++){
        ticcmd_t *c=&netcmds[0][(gametic/ticdup)%BACKUPTICS];memset(c,0,sizeof(*c));
        c->angleturn=act==0?512:act==1?-512:0;c->buttons=act==2?BT_ATTACK:0;c->forwardmove=backward?-25:forward?25:0;
        if(agm_action_locked()){c->buttons=0;c->forwardmove=0;}
        if(ending_at>=0)c->angleturn=0;
        int before_health=cartoon_health();
        G_Ticker();gametic++;maketic++;tick_count++;
        players[0].bonuscount=0;
        int delta=before_health-cartoon_health();
        if(delta>0){damage_events[j]=(float)delta;combat_state[5]+=delta;combat_state[9]+=delta;}
        for(int i=0;i<5;i++){
            if(slots[i] && slots[i]->health<=0){
                if(i==nearest_slot && slot_life[i]==nearest_life)telemetry[7]++;
                slots[i]=0;wait_tics[i]=90;}
            else if(ending_at<0 && !slots[i] && --wait_tics[i]<=0)spawn_opponent(i,(rng()>>16)&(FINEANGLES-1));
        }
        update_picnic();
    }
    float displacement=hypot2(player_x()-x0,player_y()-y0);
    combat_state[4]=(float)cartoon_health();
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
const float *arena_picnic(void){return picnic_state;}
const float *arena_sensors(void){return sensors;}
const float *arena_telemetry(void){return telemetry;}
const unsigned char *arena_frame(void){return doom_get_framebuffer(4);}
const float *arena_features(void){return features;}
int arena_kills(void){return players[0].killcount;}
int arena_tic(void){return tick_count;}
