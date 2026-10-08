// Adapted from the two supplied reel ZIPs: palette/look system from reel-templates-no-text + full template catalog from the Grok workspace.
// Kept framework-free so the existing Festival of Bharat app remains unchanged architecturally.

const RECENT_ZIP_PALETTE_STYLES = {
  gold:{name:"Gold Hour",bg:"#100e0b",fg:"#f6efe4",muted:"#d9cbb6",accent:"#e0b15a",panel:"#1c1812"},
  ivory:{name:"Ivory Page",bg:"#f4efe6",fg:"#1c1914",muted:"#5e564c",accent:"#8a3a32",panel:"#fffaf3"},
  brass:{name:"Temple Brass",bg:"#14110c",fg:"#f6edd9",muted:"#d8c7a4",accent:"#c6a15b",panel:"#221c14"},
  teal:{name:"Monsoon",bg:"#071416",fg:"#e7f4f2",muted:"#b7d0cb",accent:"#3ec2b0",panel:"#102226"},
  vermilion:{name:"Vermilion",bg:"#16090b",fg:"#fff1e8",muted:"#f0c7b4",accent:"#e23b2f",panel:"#2a1214"},
  charcoal:{name:"Charcoal",bg:"#0c0c0c",fg:"#f3f3f3",muted:"#bdbdbd",accent:"#ffffff",panel:"#161616"},
  sandal:{name:"Sandal",bg:"#f3e6d4",fg:"#2a2118",muted:"#6b5846",accent:"#8d4b2a",panel:"#fff6ea"},
  indigo:{name:"Indigo",bg:"#0c1020",fg:"#eef1ff",muted:"#c5cbe6",accent:"#8ea2ff",panel:"#161b33"},
  marigold:{name:"Marigold",bg:"#1a1206",fg:"#fff6df",muted:"#f0d7a4",accent:"#f0a202",panel:"#2c1e0a"},
  slate:{name:"Slate",bg:"#101418",fg:"#eef2f5",muted:"#c5ced6",accent:"#7f93a6",panel:"#1a2128"},
  rose:{name:"Rose Dusk",bg:"#1a1014",fg:"#ffeef3",muted:"#f0c9d2",accent:"#e07a9a",panel:"#2a1820"},
  forest:{name:"Forest",bg:"#0d140f",fg:"#eef6ee",muted:"#c5d6c6",accent:"#7dbe74",panel:"#172018"},
  cream:{name:"Cream",bg:"#f7f4ef",fg:"#171717",muted:"#5f5a54",accent:"#1f1f1f",panel:"#ffffff"},
  night:{name:"Night Cut",bg:"#07080b",fg:"#f4efe6",muted:"#cfc6b8",accent:"#d9c4a4",panel:"#12141a"},
  copper:{name:"Copper",bg:"#1a100c",fg:"#fff1e6",muted:"#e6cbb8",accent:"#d4784a",panel:"#2a1a14"}
};

function recentZipInk(template){
  return RECENT_ZIP_PALETTE_STYLES[template?.palette] || RECENT_ZIP_PALETTE_STYLES.night;
}

function applyRecentZipLook(ctx, template){
  const ink=recentZipInk(template);
  const W=ctx.canvas.width,H=ctx.canvas.height;
  const variant=Number(template?.variant||0);
  const mode=((variant%6)+6)%6;
  ctx.save();

  // The supplied no-text look.ts uses the palette to tint decorative elements.
  // Here we preserve the existing renderer and add the same visual language as a final pass.
  ctx.globalCompositeOperation='soft-light';
  ctx.fillStyle=ink.accent;
  ctx.globalAlpha=0.055;
  ctx.fillRect(0,0,W,H);
  ctx.globalCompositeOperation='source-over';
  ctx.globalAlpha=1;

  if(mode===0){
    ctx.fillStyle=ink.accent;ctx.fillRect(0,0,W,12);
  }else if(mode===1){
    ctx.fillStyle=ink.accent;ctx.fillRect(0,H-14,W,14);
  }else if(mode===2){
    ctx.fillStyle=ink.accent;ctx.fillRect(0,0,16,H);
  }else if(mode===3){
    ctx.fillStyle=ink.bg;ctx.fillRect(0,0,W,86);ctx.fillRect(0,H-86,W,86);
  }else if(mode===4){
    const g=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*.18,W/2,H/2,Math.max(W,H)*.7);
    g.addColorStop(0,'rgba(0,0,0,0)');
    g.addColorStop(1,'rgba(0,0,0,.42)');
    ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  }else{
    ctx.strokeStyle=ink.accent;ctx.lineWidth=3;ctx.strokeRect(28,28,W-56,H-56);
  }

  // The no-text source also switches charcoal variants to monochrome.
  if(template?.palette==='charcoal' && variant%2===0){
    ctx.globalCompositeOperation='saturation';
    ctx.fillStyle='#000';
    ctx.globalAlpha=.78;
    ctx.fillRect(0,0,W,H);
  }
  ctx.restore();
}
