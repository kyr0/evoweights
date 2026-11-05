"""Check if allowing MOVE_BACKWARD is sufficient in the unmodified ViZDoom WAD."""
import json, math
from pathlib import Path
import vizdoom as v
def check(move):
    g=v.DoomGame()
    g.load_config(str(Path(v.scenarios_path)/'defend_the_center.cfg'))
    g.add_available_button(v.Button.MOVE_BACKWARD)
    g.set_window_visible(False);g.set_sound_enabled(False);g.set_seed(9000)
    g.init()
    try:
        g.new_episode()
        variables=[v.GameVariable.POSITION_X,v.GameVariable.POSITION_Y,v.GameVariable.AMMO2]
        def snapshot():return [g.get_game_variable(k) for k in variables]
        before=snapshot()
        for _ in range(8):g.make_action([False,False,True,move],2)
        after=snapshot()
        return {'buttons':[b.name for b in g.get_available_buttons()], 'before':before,'after':after,
                'displacement':math.hypot(after[0]-before[0],after[1]-before[1])}
    finally:g.close()
print(json.dumps({'fire':check(False),'back_and_fire':check(True)},indent=2))
