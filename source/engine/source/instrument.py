"""Instrument visible masked sprite spans; track exactly the drawn, non-occluded pixels."""
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
def insert(a,b):
    global s
    if s.count(a)!=1:raise RuntimeError('Unsupported upstream header: '+a[:80])
    s=s.replace(a,b)
insert('#define MAXVISSPRITES 128', '#define MAXVISSPRITES 512')
insert('    int mobjflags;', '    int mobjflags;\n    unsigned char agm_slot;')
insert('    vis->mobjflags = thing->flags;', '    vis->mobjflags = thing->flags;\n    vis->agm_slot = agm_slot_id(thing);')
insert('    vis->mobjflags = 0;', '    vis->mobjflags = 0;\n    vis->agm_slot = 0;')
insert('void R_DrawMaskedColumn(column_t* column)\n{','static unsigned char agm_mask[320*200];\nstatic int agm_slot_id(const void *);\nstatic int agm_monster_draw;\nvoid R_DrawMaskedColumn(column_t* column)\n{')
insert('            dc_source = (byte*)column + 3;', '''            if (dc_x >= 0 && dc_x < 320) {
                int first = dc_yl < 0 ? 0 : dc_yl, last = dc_yh >= 200 ? 199 : dc_yh;
                for (int y = first; y <= last; ++y) agm_mask[y*320+dc_x] = agm_monster_draw;
            }
            dc_source = (byte*)column + 3;''')
insert('void R_DrawVisSprite(vissprite_t* vis, int x1, int x2)\n{','void R_DrawVisSprite(vissprite_t* vis, int x1, int x2)\n{\n    agm_monster_draw = ((vis->mobjflags & MF_COUNTKILL) && !(vis->mobjflags & MF_CORPSE)) ? vis->agm_slot : 0;')
insert('    colfunc = basecolfunc;\n}\n\n\n//\n// R_ProjectSprite','    colfunc = basecolfunc;\n    agm_monster_draw = 0;\n}\n\n\n//\n// R_ProjectSprite')
insert('void P_RadiusAttack(mobj_t* spot, mobj_t* source, int damage);',
       'static void agm_player_hitscan(const void *target);\nstatic void agm_attack_begin(int kind);\nstatic void agm_attack_end(void);\nvoid P_RadiusAttack(mobj_t* spot, mobj_t* source, int damage);')
insert('        P_DamageMobj(th, shootthing, shootthing, la_damage);',
       '    {\n        if (shootthing == players[0].mo && th->health > 0) agm_player_hitscan(th);\n        P_DamageMobj(th, shootthing, shootthing, la_damage);\n    }')
# Record the weapon's actual attack callback; a held FIRE command can be in windup.
insert('    P_LineAttack(player->mo, angle, MELEERANGE, slope, damage);',
       '    agm_attack_begin(2);\n    P_LineAttack(player->mo, angle, MELEERANGE, slope, damage);\n    agm_attack_end();')
insert('void A_Punch(player_t* player, pspdef_t* psp)\n{',
       'void A_Punch(player_t* player, pspdef_t* psp)\n{\n    if (agm_action_locked()) return;')
pistol_start=s.index('void A_FirePistol(player_t* player, pspdef_t* psp)\n{')
pistol_end=s.index('\n}',pistol_start)
pistol=s[pistol_start:pistol_end]
line='    P_GunShot(player->mo, !player->refire);'
if pistol.count(line)!=1:raise RuntimeError('Unsupported A_FirePistol')
insert(pistol, pistol.replace(line,'    agm_attack_begin(1);\n'+line+'\n    agm_attack_end();'))
# Compile-time-only bite research hooks. The public build has neither their code nor their exports.
insert('static void agm_attack_end(void);', '''static void agm_attack_end(void);
static int agm_action_locked(void);
static int agm_cartoon_damage(mobj_t *target);
static int agm_wait_for_hug(mobj_t *actor);
#ifdef AGM_BITE_AUDIT
static void agm_bite_start(mobj_t *actor);
static void agm_bite_strike(mobj_t *actor, int health_before);
#endif''')
insert('        P_SetMobjState(actor, actor->info->meleestate);',
       '''#ifdef AGM_BITE_AUDIT
        if (actor->type == MT_SERGEANT && actor->target == players[0].mo) agm_bite_start(actor);
#endif
        P_SetMobjState(actor, actor->info->meleestate);''')
bite_start=s.index('void A_SargAttack(mobj_t* actor)\n{')
bite_end=s.index('\n}',bite_start)
bite=s[bite_start:bite_end]
insert(bite,bite.replace('    int damage;', '''    int damage;
#ifdef AGM_BITE_AUDIT
    int health_before = players[0].health;
#endif''')+'''
#ifdef AGM_BITE_AUDIT
    if (actor->target == players[0].mo) agm_bite_strike(actor, health_before);
#endif''')
# HuggingDOOM changes are injected at verified single matches, leaving the
# vendored GPL source untouched and its exact upstream revision identifiable.
insert('void A_Chase(mobj_t* actor)\n{',
       'void A_Chase(mobj_t* actor)\n{\n    if (agm_wait_for_hug(actor)) return;')
insert('void A_SargAttack(mobj_t* actor)\n{',
       'void A_SargAttack(mobj_t* actor)\n{\n    if (agm_wait_for_hug(actor)) return;')
insert('void A_FirePistol(player_t* player, pspdef_t* psp)\n{',
       'void A_FirePistol(player_t* player, pspdef_t* psp)\n{\n    if (agm_action_locked()) return;')
insert('    if ( !(target->flags & MF_SHOOTABLE) )',
       '    if (agm_cartoon_damage(target)) return;\n\n    if ( !(target->flags & MF_SHOOTABLE) )')
Path(sys.argv[2]).write_text(s)
