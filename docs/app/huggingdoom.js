/** Effects are drawn into the recorded framebuffer, with reduced-motion support. */
export class HuggingDoomView {
    previous = null;
    effects = [];
    reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    reset() {
        this.previous = null;
        this.effects = [];
    }
    draw(ctx, state) {
        if (this.previous && state.tic < this.previous.tic)
            this.reset();
        const last = this.previous;
        if (last && state.tic > last.tic) {
            if (state.ammo < last.ammo)
                this.effects.push({ kind: 'honey', tic: state.tic });
            if (state.ammo === 0 && last.ammo > 0)
                this.effects.push({ kind: 'unfold', tic: state.tic });
            if (state.picnic && last.picnic) {
                if (state.picnic.bearsFed > last.picnic.bearsFed)
                    this.effects.push({ kind: 'crumbs', tic: state.tic });
                if (state.picnic.bearsBefriended > last.picnic.bearsBefriended)
                    this.effects.push({ kind: 'hearts', tic: state.tic });
            }
        }
        this.previous = state;
        this.effects = this.effects.filter((e) => state.tic - e.tic < 38).slice(-12);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.font = 'bold 10px sans-serif';
        for (const effect of this.effects) {
            const age = (state.tic - effect.tic) / 35;
            const fade = Math.max(0, 1 - age);
            ctx.globalAlpha = fade;
            if (effect.kind === 'honey' && age < 0.45) {
                const t = this.reducedMotion ? 0.8 : age / 0.45;
                this.honey(ctx, 160, 175 - 85 * t, 13 - 8 * t);
            }
            else if (effect.kind === 'crumbs') {
                for (let i = 0; i < 14; i++) {
                    const a = (i / 14) * Math.PI * 2;
                    const d = this.reducedMotion ? 20 : 10 + age * 42;
                    ctx.fillStyle = i % 2 ? '#ffc53d' : '#fff3a3';
                    ctx.fillRect(160 + Math.cos(a) * d, 105 + Math.sin(a) * d * 0.6 + age * age * 23, 3, 3);
                }
                this.caption(ctx, 'plop!', 76, '#664114');
            }
            else if (effect.kind === 'hearts') {
                for (let i = 0; i < 5; i++) {
                    const drift = this.reducedMotion ? 0 : age * 34;
                    this.heart(ctx, 96 + i * 32, 95 - drift - (i % 2) * 14, 15 + (i % 3) * 6);
                }
                this.caption(ctx, 'Mmmrrraww.', 54, '#8e3653');
            }
            else if (effect.kind === 'unfold')
                this.caption(ctx, 'click… Hug time!', 58, '#6b4b18');
        }
        ctx.globalAlpha = 1;
        if (state.picnic?.ending) {
            ctx.fillStyle = 'rgba(255, 249, 219, .92)';
            ctx.fillRect(24, 12, 272, 34);
            this.caption(ctx, 'Wait… there was emergency honey?', 24, '#59441c');
            ctx.font = '8px sans-serif';
            ctx.fillStyle = '#59441c';
            ctx.fillText('The bears have found your back pocket.', 160, 37);
            this.honey(ctx, 160, 167, 14);
        }
        ctx.restore();
    }
    caption(ctx, text, y, color) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff9de';
        ctx.strokeText(text, 160, y);
        ctx.fillStyle = color;
        ctx.fillText(text, 160, y);
    }
    honey(ctx, x, y, r) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
            if (i === 0)
                ctx.moveTo(px, py);
            else
                ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffc83d';
        ctx.strokeStyle = '#bb791f';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffe99a';
        ctx.fillRect(x - r * 0.3, y - r * 0.4, r * 0.45, r * 0.45);
    }
    heart(ctx, x, y, size) {
        ctx.beginPath();
        ctx.moveTo(x, y + size);
        ctx.bezierCurveTo(x - size * 2, y - size * 0.3, x - size, y - size, x, y - size * 0.2);
        ctx.bezierCurveTo(x + size, y - size, x + size * 2, y - size * 0.3, x, y + size);
        ctx.fillStyle = '#f57391';
        ctx.fill();
        ctx.strokeStyle = '#fff4ed';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}
