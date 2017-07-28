//------------------------------------------------------------------------------
//
// Eschersketch - A drawing program for exploring symmetrical designs
//
// Main UI
//
// Copyright (c) 2017 Anselm Levskaya (http://anselmlevskaya.com)
// Licensed under the MIT (http://www.opensource.org/licenses/mit-license.php)
// license.
//
//------------------------------------------------------------------------------

// Imports
import { _ } from 'underscore';
import Vue from 'vue';
import {Chrome} from 'vue-color';
import {saveAs} from 'file-saver';
import {generateTiling, generateLattice, planarSymmetries} from './geo';

import {pixelFix, setCanvasPixelDensity} from './canvas_utils';

// Constants
export const gConstants = {
  CANVAS_WIDTH:     1600,
  CANVAS_HEIGHT:    1200,
  MIN_LINEWIDTH:    0.1,
  MAX_LINEWIDTH:    10,
  DELTA_LINEWIDTH:  0.1,
  GRIDNX:           18,
  GRIDNY:           14,
  INITSYM:          'p6m',
  // All Symmetries made available
  ALLSYMS:          ['p1','diagonalgrid','pm','cm','pg', //rot-free
                     'pmg','pgg','pmm','p2','cmm',   //180deg containing
                     'p4', 'p4g', 'p4m',             //square
                     'hexgrid','p3','p6','p31m','p3m1','p6m'] //hex
};

// gS = global State, holds the UI state
// as well as acting as top-level event bus
export const gS = new Vue({
  data: {
    // Symmetry State
    //-------------------------------
    symstate: {sym: gConstants.INITSYM},
    // grid Nx, Ny should NOT be too large, should clamp.
    gridstate: {x:800, y:400, d:100, t:0, Nx:18, Ny:14},
    // Style State
    //-------------------------------
    ctxStyle: {
      lineCap: "butt", // butt, round, square
      lineJoin: "round", // round, bevel, miter
      miterLimit: 10.0, // applies to miter setting above
      lineWidth: 1.0
    },
    fillcolor:   {target: "fill",   r: 200, g:100, b:100, a:0.0},
    strokecolor: {target: "stroke", r: 100, g:100, b:100, a:1.0},
    // Global Command and Redo Stacks
    //-------------------------------
    cmdstack: [], //<-- needed in here?
    redostack: [],
  }
});
gS.$on('rerender', function() { rerender(ctx); });
gS.$on('symmUpdate',
       function(symName, gridSetting) {
         gS.cmdstack.push(new SymmOp(symName, _.clone(gridSetting)));
         rerender(ctx);
       });
gS.$on('styleUpdate',
       function(updateDict) {
         gS.cmdstack.push(new StyleOp(_.clone(updateDict)));
         rerender(ctx);
       });
gS.$on('colorUpdate',
       function(clr) {
         gS.cmdstack.push(new ColorOp(clr.target, clr.r, clr.g, clr.b, clr.a));
         rerender(ctx);
       });

// HACK: for debugging
window.gS=gS;



// Canvas / Context Globals
//------------------------------------------------------------------------------
var livecanvas = {};
var lctx = {};
var canvas = {};
var ctx = {};

// stores the rescaling ratio used by pixelFix,
// needed for pixel-level manipulation
var pixelratio = 1;

// stores symmetry affine transforms
var lattice = {};
var affineset = {};


// Math Functions
//------------------------------------------------------------------------------
var l2norm = pt => Math.sqrt(Math.pow(pt[0],2) + Math.pow(pt[1],2));
var l2dist = (pt0, pt1) => Math.sqrt(Math.pow(pt1[0]-pt0[0],2) +
                                    Math.pow(pt1[1]-pt0[1],2));
var sub2      = (pt1, pt0)  => [pt1[0]-pt0[0], pt1[1]-pt0[1]];
var add2      = (pt1, pt0)  => [pt1[0]+pt0[0], pt1[1]+pt0[1]];
var scalar2   = (pt, alpha) => [pt[0]*alpha, pt[1]*alpha];
var normalize = (pt)        => scalar2(pt, 1.0/l2norm(pt));
// reflect pt1 through pt0
var reflectPoint = (pt0, pt1) => sub2(pt0, sub2(pt1, pt0));


// Symmetry Selection UI
//------------------------------------------------------------------------------
import symmetryUi from './components/symmetryUI';
var vueSym = new Vue({
  el: '#symUI',
  template: '<symmetry-ui :selected="selected" :allsyms="allsyms"/>',
  components: { symmetryUi },
  data: { selected: gS.symstate , 'allsyms': gConstants.ALLSYMS}
});

// Grid UI
//------------------------------------------------------------------------------
import gridUi from './components/gridUI';
var vueGrid = new Vue({
  el: '#gridUI',
  template: '<grid-ui :x="x" :y="y" :d="d"/>',
  components: {gridUi},
  data: gS.gridstate
});

// Line Styling UI
//------------------------------------------------------------------------------
import styleUi from './components/styleUI';
var vueStyle = new Vue({
  el: '#styleUI',
  template: '<style-ui :lineWidth="lineWidth"/>',
  components: {styleUi},
  data: gS.ctxStyle
});

// Color UI
//------------------------------------------------------------------------------
import colorUi from './components/colorUI';
var vueColor = new Vue({
  el: '#colorUI',
  template: '<color-ui :strokeColor="strokeColor" :fillColor="fillColor"/>',
  components: {colorUi},
  data: {strokeColor: gS.strokecolor,
         fillColor: gS.fillcolor}
});




// Mouse Events -- dispatched to active Drawing Tool
//------------------------------------------------------------------------------
var dispatchMouseDown = function(e) {
  e.preventDefault(); //?
  drawTools[curTool].mouseDown(e);
};

var dispatchMouseUp = function(e) {
  e.preventDefault(); //?
  drawTools[curTool].mouseUp(e);
};

var dispatchMouseMove = function(e) {
  e.preventDefault(); //?
  drawTools[curTool].mouseMove(e);
};

var dispatchMouseLeave = function(e) {
  if("mouseLeave" in drawTools[curTool]) {
    drawTools[curTool].mouseLeave(e);
  }
};

var dispatchKeyDown = function(e) {
  if("keyDown" in drawTools[curTool]) {
    drawTools[curTool].keyDown(e);
  }
};



// Command Stack
//------------------------------------------------------------------------------
/* - objectify this
   - think about adding "caching layers" of canvas contexts to speed up render
     times during redos of complicated scenes
   - figure out how to fuse context updaters, e.g. color, symmetry, etc, they
     don't need to be stacked deep in the command stack
   - when to clear out redo stack?
   - shoudn't be able to clear the context initialization ops, otherwise redos
     unstable, keep color/symm inits in place...
*/

var rerender = function(ctx, clear=true) {
  //console.log("rerendering ", gS.cmdstack.length, " ops");
  if(clear){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  for(var cmd of gS.cmdstack){
    cmd.render(ctx);
  }
};

var undo_init_bound = 0;
var undo = function(){
  //make sure stateful drawing tool isn't left in a weird spot
  if('exit' in drawTools[curTool]) {drawTools[curTool].exit();}
  if(gS.cmdstack.length > undo_init_bound){
    var cmd = gS.cmdstack.pop();
    gS.redostack.push(cmd);
    rerender(ctx);
  }
};
var redo = function(){
  if(gS.redostack.length>0){
    var cmd = gS.redostack.pop();
    gS.cmdstack.push(cmd);
    rerender(ctx);
  }
};
var reset = function(){
  //make sure stateful drawing tool isn't left in a weird spot
  if('exit' in drawTools[curTool]) {drawTools[curTool].exit();}
  gS.cmdstack = [];
  initState();
};

document.getElementById("undo").onmousedown =
  function(e) {
    e.preventDefault();
    undo();
  };
document.getElementById("redo").onmousedown =
  function(e) {
    e.preventDefault();
    redo();
  };
document.getElementById("reset").onmousedown =
  function(e) {
    e.preventDefault();
    if(e.target.classList.contains('armed')){
      reset();
      e.target.classList.remove('armed');
      e.target.innerHTML = "reset";
    } else {
      e.target.classList.add('armed');
      e.target.innerHTML = "reset?!";
    }
  };
document.getElementById("reset").onmouseleave =
  function(e) {
    if(e.target.classList.contains('armed')){
      e.target.classList.remove('armed');
      e.target.innerHTML = "reset";
    }
  };

//------------------------------------------------------------------------------
// Context / State Update Ops
//------------------------------------------------------------------------------
var memo_generateTiling = _.memoize(generateTiling,
                                function(){return JSON.stringify(arguments);});
var memo_generateLattice = _.memoize(generateLattice,
                                function(){return JSON.stringify(arguments);});
var updateTiling = function(sym, gridstate) {
  affineset = memo_generateTiling(planarSymmetries[sym],
                                  gConstants.GRIDNX, gConstants.GRIDNY,
                                  gridstate.d, gridstate.t,
                                  gridstate.x, gridstate.y);
  lattice = memo_generateLattice(planarSymmetries[sym],
                                 gConstants.GRIDNX, gConstants.GRIDNY,
                                 gridstate.d, gridstate.t,
                                 gridstate.x, gridstate.y);
};


// SymmOp sets up set of affine trafos for a given symmetry
//------------------------------------------------------------------------------
class SymmOp {
  constructor(sym, grid) {
    this.sym = sym;
    this.grid = grid;
  }

  render(ctx){
    // update global storing current affineset
    updateTiling(this.sym, this.grid);
    // directly mutate global that's watched by vue
    gS.symstate.sym = this.sym;
    gS.gridstate.x = this.grid.x;
    gS.gridstate.y = this.grid.y;
    gS.gridstate.d = this.grid.d;
    gS.gridstate.t = this.grid.t;

    //HACK: if the gridtool is active, update canvas if the grid ui is altered
    if(curTool=="grid"){ drawTools["grid"].enter(); }
  }

  serialize(){
    return ["sym", this.sym, this.grid.x, this.grid.y, this.grid.d, this.grid.t];
  }

  deserialize(data){
    return new SymmOp(data[1], data[2], data[3], data[4], data[5]);
  }
}


// ColorOp sets stroke color of ctx
//------------------------------------------------------------------------------
class ColorOp {
  constructor(target,r,g,b,a) {
    this.target = target; // "fill" or "stroke"
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }

  render(ctx){
    if(this.target == "stroke") {
      ctx.strokeStyle = "rgba("+this.r+","+this.g+","+this.b+","+this.a+")";
      // HACK: ghetto, fix application to all contexts...
      lctx.strokeStyle = "rgba("+this.r+","+this.g+","+this.b+","+this.a+")";
      // HACK: directly mutate global that's watched by vue...
      gS.strokecolor.r = this.r;
      gS.strokecolor.g = this.g;
      gS.strokecolor.b = this.b;
      gS.strokecolor.a = this.a;
    }
    else if(this.target == "fill") {
      ctx.fillStyle = "rgba("+this.r+","+this.g+","+this.b+","+this.a+")";
      // HACK: ghetto, fix application to all contexts...
      lctx.fillStyle = "rgba("+this.r+","+this.g+","+this.b+","+this.a+")";
      // HACK: directly mutate global that's watched by vue...
      gS.fillcolor.r = this.r;
      gS.fillcolor.g = this.g;
      gS.fillcolor.b = this.b;
      gS.fillcolor.a = this.a;
    }
  }

  serialize(){
    return ["color", this.target, this.r, this.g, this.b, this.a];
  }

  deserialize(data){
    return new ColorOp(data[1], data[2], data[3], data[4], data[5]);
  }
}

class StyleOp {
  /*
    lineCap	Sets or returns the style of the end caps for a line
    lineJoin	Sets or returns the type of corner created, when two lines meet
    lineWidth	Sets or returns the current line width
    miterLimit  Sets or returns the maximum miter length
  */
  constructor(styleProps) {
    this.styleProps = Object.assign({}, gS.ctxStyle, styleProps);
  }

  render(ctx){
    for(var prop of Object.keys(this.styleProps)){
      ctx[prop] = this.styleProps[prop];
      // HACK: ghetto, fix application to all contexts...
      lctx[prop] = this.styleProps[prop];
      // HACK: directly mutate global that's watched by vue...
      gS.ctxStyle[prop] = this.styleProps[prop];
    }
  }

  serialize(){
    return ["style", this.styleProps];
  }

  deserialize(data){
    return new StyleOp(data[1]);
  }
}



//------------------------------------------------------------------------------
// Drawing Ops and Tools
//------------------------------------------------------------------------------

class GridTool {
  constructor() {
    Object.assign(this, gS.gridstate); //x,y,d,t
    this.p0 = [0,0];
    this.p1 = [0,0];
    this.hitRadius = 10;
    this.state = "off";
  }

  enter(){
    Object.assign(this, gS.gridstate); //x,y,d,t
    this.liverender();
  }

  exit(){
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  commit(){
    gS.cmdstack.push(new SymmOp(gS.symstate.sym, {x: this.x, y: this.y, d: this.d, t: this.t}));
    rerender(ctx);
  }

  mouseDown(e) {
    e.preventDefault();
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];
    if(l2dist(pt,this.p0)<this.hitRadius){
      this.state = "move";
    }
    if(l2dist(pt,this.p1)<this.hitRadius){
      this.state = "scale";
    }
  }

  mouseMove(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];
    // dynamic mouse-pointer logic
    if(l2dist(pt, this.p0)<this.hitRadius && this.state == "off"){
      livecanvas.style.cursor="all-scroll";
    } else if(l2dist(pt, this.p1)<this.hitRadius && this.state == "off"){
      livecanvas.style.cursor="ew-resize";
    } else if(this.state == "off"){
      livecanvas.style.cursor="crosshair";
    } else {
      livecanvas.style.cursor="none";
    }

    if (this.state == "move") {
      this.x = pt[0];
      this.y = pt[1];
      this.liverender();
    }
    if (this.state == "scale") {
      let dist = l2dist(pt, this.p0);
      //grid vector not unit vectors! so we correct:
      let alpha = l2dist(this.p1, this.p0)/this.d;
      this.d = dist/alpha;
      this.liverender();
    }
  }

  mouseUp(e) {
    if(this.state != "off"){
      this.commit();
      this.state = "off";
      this.liverender();
    }
  }

  liverender() {
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
    //const v0 = RotationTransform(this.t).onVec(planarSymmetries[gS.symstate.sym].vec0);
    //const v1 = RotationTransform(this.t).onVec(planarSymmetries[gS.symstate.sym].vec1);
    const v0 = planarSymmetries[gS.symstate.sym].vec0;
    const v1 = planarSymmetries[gS.symstate.sym].vec1;
    let p0 = [this.x, this.y];
    let p1 = [(this.d * v0[0]) + this.x, (this.d * v0[1]) + this.y];
    let p2 = [(this.d * v1[0]) + this.x, (this.d * v1[1]) + this.y];
    this.p0 = p0; //save for canvas hit-detection
    this.p1 = p1;

    let newlattice = generateLattice(planarSymmetries[gS.symstate.sym],
                                  gConstants.GRIDNX, gConstants.GRIDNY,
                                  this.d, this.t,
                                  this.x, this.y);
    // Draw Lattice
    lctx.save();
    lctx.strokeStyle = "rgba(0,0,0,1.0)";
    for (let af of newlattice) {
      let Tp0 = af.on(p0[0],p0[1]);
      let Tp1 = af.on(p1[0],p1[1]);
      let Tp2 = af.on(p2[0],p2[1]);
      lctx.beginPath();
      lctx.moveTo(Tp0[0],Tp0[1]);
      lctx.lineTo(Tp1[0],Tp1[1]);
      lctx.moveTo(Tp0[0],Tp0[1]);
      lctx.lineTo(Tp2[0],Tp2[1]);
      lctx.stroke();
    }
    lctx.restore();

    const circR = this.hitRadius;
    lctx.save();
    lctx.fillStyle = "rgba(0,0,0,0.1)";
    lctx.lineWidth = 4.0;
    if(this.state == "move"){ lctx.strokeStyle = "rgba(0,255,0,0.5)";}
    else {lctx.strokeStyle = "rgba(0,0,0,0.5)";}
    lctx.beginPath();
    lctx.arc(p0[0], p0[1], circR, 0, 2*Math.PI);
    lctx.stroke();
    lctx.fill();
    if(this.state == "scale"){ lctx.strokeStyle = "rgba(0,255,0,0.5)";}
    else {lctx.strokeStyle = "rgba(0,0,0,0.5)";}
    lctx.beginPath();
    lctx.arc(p1[0], p1[1], circR, 0, 2*Math.PI);
    lctx.stroke();
    lctx.fill();
    lctx.restore();
  }
}


// Draw Single Line Segments
//------------------------------------------------------------------------------
class LineOp {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  render(ctx){
    for (let af of affineset) {
      const Tp1 = af.on(this.start.x, this.start.y);
      const Tp2 = af.on(this.end.x, this.end.y);
      ctx.beginPath();
      ctx.moveTo(Tp1[0], Tp1[1]);
      ctx.lineTo(Tp2[0], Tp2[1]);
      ctx.stroke();
    }
  }

  serialize(){
    return ["line", this.start, this.end];
  }

  deserialize(data){
    return new LineOp(data[1], data[2]);
  }
}

class FancyLineTool {
  constructor() {
    this.start = {};
    this.end = {};
    this.state = "init";
    this.drawInterval = 0;
    this.hitRadius = 4
  }

  liverender() {
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let af of affineset) {
      const Tp1 = af.on(this.start.x, this.start.y);
      const Tp2 = af.on(this.end.x, this.end.y);
      lctx.beginPath();
      lctx.moveTo(Tp1[0], Tp1[1]);
      lctx.lineTo(Tp2[0], Tp2[1]);
      lctx.stroke();
    }
    lctx.save();
    lctx.fillStyle = "rgba(255,0,0,0.2)";
    lctx.lineWidth = 1.0;
    lctx.strokeStyle = "rgba(255,0,0,1.0)";
    lctx.beginPath();
    lctx.arc(this.start.x-1, this.start.y-1, this.hitRadius, 0, 2*Math.PI);
    lctx.stroke();
    lctx.fill();
    lctx.beginPath();
    lctx.arc(this.end.x-1, this.end.y-1, this.hitRadius, 0, 2*Math.PI);
    lctx.stroke();
    lctx.fill();
    lctx.restore();
  }

  commit() {
    gS.cmdstack.push( new LineOp(this.start, this.end) );
    rerender(ctx);
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  cancel() {
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
    this.state = "init";
    this.start = {};
    this.end = {};
  }

  mouseDown(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];
    if(l2dist(pt,[this.start.x,this.start.y])<this.hitRadius) {
      this.state = "moveStart";
    } else if(l2dist(pt,[this.end.x,this.end.y])<this.hitRadius) {
      this.state = "moveEnd";
    } else {
      if(this.state=="off") {
        this.commit();
      }
      this.state = "newLine";
      this.start = { x: pt[0], y: pt[1] };
    }
  }

  mouseMove(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];
    if (this.state == "newLine") {
      if (this.drawInterval <= 0) {
        this.end = { x: pt[0], y: pt[1] };
        this.liverender();
        this.drawInterval = 1;
      }
      this.drawInterval--;
    }
    else if (this.state == "moveStart") {
      this.start = { x: pt[0], y: pt[1] };
      this.liverender();
    }
    else if (this.state == "moveEnd") {
      this.end = { x: pt[0], y: pt[1] };
      this.liverender();
    }
  }

  mouseUp(e) {
    this.state = "off";
  }

  mouseLeave(e) {
    this.exit();
  }

  keyDown(e) {
    if(e.code == "Enter"){
      this.state = "off";
      this.commit();
      this.start = {};
      this.end = {};
    } else if(e.code=="Escape"){
      this.cancel();
    }
  }

  exit(){
    if(this.state=="off") {
      this.commit();
      this.start = {};
      this.end = {};
      this.state = "init";
    }
  }
}



// Draw Raw Mousepath (Pencil)
//------------------------------------------------------------------------------
//TODO: add smoothing factor
class PencilOp {
  constructor(points) {
    this.points = points;
  }

  render(ctx){
    for (let af of affineset) {
      ctx.beginPath();
      const Tpt0 = af.on(this.points[0].x, this.points[0].y);
      ctx.moveTo(Tpt0[0], Tpt0[1]);
      for (let pt of this.points.slice(1)) {
        const Tpt = af.on(pt.x, pt.y);
        ctx.lineTo(Tpt[0], Tpt[1]);
      }
      ctx.stroke();
    }
  }

  serialize(){
    return ["pencil", this.points];
  }

  deserialize(data){
    return new PencilOp(data[1]);
  }
}

class PencilTool {
  constructor() {
    this.points = [];
    this.on = false;
    this.drawInterval = 0;
  }

  liverender() {
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let af of affineset) {
      lctx.beginPath();
      const Tpt0 = af.on(this.points[0].x, this.points[0].y);
      lctx.moveTo(Tpt0[0], Tpt0[1]);
      for (let pt of this.points.slice(1)) {
        const Tpt = af.on(pt.x, pt.y);
        lctx.lineTo(Tpt[0], Tpt[1]);
      }
      lctx.stroke();
    }
  }

  commit() {
    gS.cmdstack.push( new PencilOp(this.points) );
    rerender(ctx);
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  mouseDown(e) {
    var rect = livecanvas.getBoundingClientRect();
    this.points.push({ x: e.clientX - rect.left,
                       y: e.clientY - rect.top});
    this.on = true;
  }

  mouseMove(e) {
    if (this.on) {
      if (this.drawInterval <= 0) {
        var rect = livecanvas.getBoundingClientRect();
        this.points.push({ x: e.clientX - rect.left,
                           y: e.clientY - rect.top});
        this.liverender();
        this.drawInterval = 1;
      }
      this.drawInterval--;
    }
  }

  mouseUp(e) {
    this.on = false;
    this.commit();
    this.points = [];
  }
}


class PolyOp {
  constructor(points) {
    this.points = points;
  }

  render(ctx) {
    for (let af of affineset) {
      ctx.beginPath();
      let Tpt = af.on(this.points[0][0], this.points[0][1]);
      ctx.moveTo(Tpt[0], Tpt[1]);
      for(let pt of this.points.slice(1)) {
        Tpt = af.on(pt[0], pt[1]);
        ctx.lineTo(Tpt[0], Tpt[1]);
      }
      ctx.closePath(); //necessary?
      ctx.stroke();
      ctx.fill();
    }
  }

  serialize() {
    return ["polygon", this.points];
  }

  deserialize(data) {
    return new PolyOp(data[1]);
  }
}

const _INIT = 0;
const _OFF  = 1;
const _ON   = 2;
const _MOVE = 3;
class PolyTool {
  constructor() {
    this.points = [];
    this.state = _INIT;
    this.selected = -1;
    this.hitRadius = 4;
  }

  liverender() {
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let af of affineset) {
      lctx.beginPath();
      let Tpt = af.on(this.points[0][0], this.points[0][1]);
      lctx.moveTo(Tpt[0], Tpt[1]);
      for(let pt of this.points.slice(1)) {
        Tpt = af.on(pt[0], pt[1]);
        lctx.lineTo(Tpt[0], Tpt[1]);
      }
      lctx.stroke();
      if(this.points.length > 2) {
        lctx.fill();
      }
    }
    // draw handles
    lctx.save();
    lctx.lineWidth = 1.0;
    lctx.fillStyle   = "rgba(255,0,0,0.2)";
    lctx.strokeStyle = "rgba(255,0,0,1.0)";
    for(let pt of this.points) {
      lctx.beginPath();
      lctx.arc(pt[0]-1, pt[1]-1, this.hitRadius, 0, 2*Math.PI);
      lctx.stroke();
      lctx.fill();
    }
    lctx.restore();
  }

  commit() {
    gS.cmdstack.push( new PolyOp(this.points) );
    rerender(ctx);
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  cancel() {
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
    this.state = _INIT;
    this.points = [];
  }

  mouseDown(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];

    if(this.state == _OFF) {
      let onPoint=false;
      for(let idx=0; idx<this.points.length; idx++) {
        if(l2dist(pt,this.points[idx])<this.hitRadius) {
          this.state = _MOVE;
          this.selected = idx;
          onPoint = true;
          break;
        }
      }
      if(!onPoint){
        this.state = _ON;
        this.selected = this.points.length;
        this.points.push( [pt[0], pt[1]] );
        this.liverender();
      }
    }
    else if(this.state == _INIT) {
      this.state = _ON;
      this.points = [ [pt[0], pt[1]] ];
      this.selected = 0; //?
      this.liverender();
    }
    else if(this.state == _ON) {
      this.selected += 1;//this.state + 1;
      this.points.push( [pt[0], pt[1]] );
      this.liverender();
    }
  }

  mouseMove(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];

    if (this.state == _ON) {
      this.points[this.points.length-1] = [pt[0], pt[1]];
      this.liverender();
    }
    if (this.state == _MOVE) {
      this.points[this.selected] = [pt[0], pt[1]];
      this.liverender();
    }

  }

  mouseUp(e) {
    this.state = _OFF;
  }

  mouseLeave(e) {
    this.exit();
  }

  keyDown(e) {
    if(e.code == "Enter"){
      this.state = _OFF;
      this.commit();
      this.points = [];
      this.selected = 0;
    } else if(e.code=="Escape"){
      this.cancel();
    } else if(e.code=="KeyD"){
      if(this.points.length > 1 &&
         this.state == _OFF) {
        this.points.pop();
        this.selected -= 1;
        this.liverender();
      }
    }
  }

  exit(){
    if(this.state==_OFF) {
      if(this.points.length >2){
        this.commit();
      }
      this.points = [];
      this.selected = 0;
      this.state = _INIT;
    }
  }
}


class BezierOp {
  constructor(ops) {
    this.ops = ops; //array of ["M",x,y] or ["L",x,y] or ["C",xc1,yc1,xc2,yc2,x,y]
  }

  render(ctx) {
    for (let af of affineset) {
      ctx.beginPath();
      for(let op of this.ops){
        if(op[0] == "M") {
          let Tpt = af.on(op[1], op[2]);
          ctx.moveTo(Tpt[0], Tpt[1]);
        }
        else if(op[0] == "L") {
          let Tpt = af.on(op[1], op[2]);
          ctx.lineTo(Tpt[0], Tpt[1]);
        }
        else if(op[0] == "C"){
          let Tpt0 = af.on(op[1], op[2]);
          let Tpt1 = af.on(op[3], op[4]);
          let Tpt2 = af.on(op[5], op[6]);
          ctx.bezierCurveTo(Tpt0[0], Tpt0[1], Tpt1[0], Tpt1[1], Tpt2[0], Tpt2[1]);
        }
      }
      ctx.stroke();
      ctx.fill();
    }
  }

  serialize() {
    return ["bezier", this.ops];
  }

  deserialize(data) {
    return new PolyOp(data[1]);
  }
}

class BezierTool {
  constructor() {
    this.ops = [];
    this.state = _INIT;
    this.cpoint = [];
    this.opselected = [];
    this.hitRadius = 4;
  }

  liverender() {
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let af of affineset) {
      lctx.beginPath();
      for(let op of this.ops){
        if(op[0] === "M") {
          let Tpt = af.on(op[1], op[2]);
          lctx.moveTo(Tpt[0], Tpt[1]);
        }
        else if(op[0] === "L") {
          let Tpt = af.on(op[1], op[2]);
          lctx.lineTo(Tpt[0], Tpt[1]);
        }
        else if(op[0] === "C"){
          let Tpt0 = af.on(op[1], op[2]);
          let Tpt1 = af.on(op[3], op[4]);
          let Tpt2 = af.on(op[5], op[6]);
          lctx.bezierCurveTo(Tpt0[0], Tpt0[1], Tpt1[0], Tpt1[1], Tpt2[0], Tpt2[1]);
        }
      }
      lctx.stroke();
      lctx.fill();
    }

    let lastpt = [];
    // draw handles
    lctx.save();
    lctx.lineWidth = 1.0;
    lctx.fillStyle   = "rgba(255,0,0,0.2)";
    lctx.strokeStyle = "rgba(255,0,0,1.0)";
    for(let op of this.ops) {
      if(op[0] == "M") {
        lctx.beginPath();
        lctx.arc(op[1], op[2], this.hitRadius, 0, 2*Math.PI);
        lctx.stroke();
        lctx.fill();
        lastpt = [op[1], op[2]];
      }
      else if(op[0] == "L") {
        lctx.beginPath();
        lctx.arc(op[1], op[2], this.hitRadius, 0, 2*Math.PI);
        lctx.stroke();
        lctx.fill();
        lastpt = [op[1], op[2]];
      }
      else if(op[0] == "C") {
        //endpoint
        lctx.beginPath();
        lctx.arc(op[5], op[6], this.hitRadius, 0, 2*Math.PI);
        lctx.stroke();
        lctx.fill();
        //control points
        lctx.save();
        lctx.fillStyle = "rgba(255,0,0,1.0)";
        lctx.beginPath();
        lctx.arc(op[1], op[2], this.hitRadius-2, 0, 2*Math.PI);
        lctx.stroke();
        lctx.fill();
        lctx.beginPath();
        lctx.arc(op[3], op[4], this.hitRadius-2, 0, 2*Math.PI);
        lctx.stroke();
        lctx.fill();
        // handle lines for control points
        lctx.beginPath();
        lctx.moveTo(lastpt[0],lastpt[1]);
        lctx.lineTo(op[1],op[2]);
        lctx.stroke();
        lctx.beginPath();
        lctx.moveTo(op[3],op[4]);
        lctx.lineTo(op[5],op[6]);
        lctx.stroke();
        lctx.restore();
        lastpt = [op[5], op[6]];
      }
    }
    if(this.cpoint.length > 0){ //temp control point render
      lctx.save();
      lctx.fillStyle = "rgba(255,0,0,1.0)";
      lctx.beginPath();
      lctx.arc(this.cpoint[0], this.cpoint[1], this.hitRadius-2, 0, 2*Math.PI);
      lctx.stroke();
      lctx.fill();
      // handle line
      lctx.beginPath();
      lctx.moveTo(lastpt[0],lastpt[1]);
      lctx.lineTo(this.cpoint[0],this.cpoint[1]);
      lctx.stroke();
      lctx.restore();
    }
    lctx.restore();
  }

  mouseDown(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];

    if(this.state == _INIT) { // NEW PATH
      this.state = _ON;
      this.ops = [ ["M", pt[0], pt[1]] ];
      this.liverender();
    }
    else if(this.state == _OFF) { // EXTANT PATH
      //-----------------------------------------------------------------------------
      // Adjustment of existing points
      let onPoint=false;
      for(let idx=0; idx<this.ops.length; idx++) {
        let op = this.ops[idx];
        if(op[0]=="M" || op[0] == "L") {
          if(l2dist(pt, [op[1],op[2]])<this.hitRadius) {
            this.state = _MOVE;
            this.opselected = [[idx,0,'v']];
            onPoint = true;

            // does this endpoint overlap with a following control point?
            if(idx+1 < this.ops.length && this.ops[idx+1][0]=="C") {
              let nextop = this.ops[idx+1];
              this.opselected.push([idx+1,0,'c']);
            }
            if(idx+1 >= this.ops.length && this.cpoint.length > 0) {
              this.opselected.push([0,0,'t']);
            }
            break;
          }
        }
        else if(op[0]=="C") {
          // curve endpoint
          if(l2dist(pt, [op[5], op[6]])<this.hitRadius) {
            this.state = _MOVE;
            this.opselected = [[idx,2,'v']];
            onPoint = true;

            // select associated endpoints
            this.opselected.push([idx,1,'c']);
            if(idx+1 < this.ops.length && this.ops[idx+1][0]=="C"){
              this.opselected.push([idx+1,0,'c']);
            }
            if(idx+1 >= this.ops.length && this.cpoint.length > 0) {
              this.opselected.push([0,0,'t']);
            }
            break;
          }

          // curve control-points - overlap ruled out by above cases
          if(l2dist(pt, [op[1], op[2]])<this.hitRadius) {
            this.state = _MOVE;
            this.opselected = [[idx,0,'c']];
            onPoint = true;
            if(this.ops[idx-1][0]=="C"){
              this.opselected.push([idx-1,1,'c']);
            }
            break;
          }
          if(l2dist(pt, [op[3], op[4]])<this.hitRadius) {
            this.state = _MOVE;
            this.opselected = [[idx,1,'c']];
            onPoint = true;
            if(idx+1 < this.ops.length && this.ops[idx+1][0]=="C"){
              this.opselected.push([idx+1,0,'c']);
            }
            if(idx+1 >= this.ops.length && this.cpoint.length > 0) {
              this.opselected.push([0,0,'t']);
            }
            break;
          }
        }
      }
      // check hit on temporary, dangling endpoint
      if(this.cpoint.length > 0){
        if(l2dist(pt, this.cpoint) < this.hitRadius){
          this.state = _MOVE;
          this.opselected = [[0,0,'t']];
          onPoint = true;
          if(this.ops[this.ops.length-1][0]=="C"){
            this.opselected.push([this.ops.length-1,1,'c']);
          }
        }
      }
      //-----------------------------------------------------------------------------
      // Adding New Points
      if(!onPoint){
        if(this.cpoint.length === 0) {
          this.state = _ON;
          this.ops.push( ["L", pt[0], pt[1]] );
          this.liverender();
        } else {
          this.state = _ON;
          this.ops.push( ["C",
                             this.cpoint[0], this.cpoint[1],
                             pt[0], pt[1],
                             pt[0], pt[1] ] );
          this.cpoint = []; //clear tmp control pt
          this.liverender();
        }
      }
    }
  }

  getOpEndPoint(op){
    if(op[0]=="M"){return [op[1],op[2]];}
    else if(op[0]=="L"){return [op[1],op[2]];}
    else if(op[0]=="C"){return [op[5],op[6]];}
  }

  //could simplify this by not using L ops at all, just twiddling C ops
  //then at end of commit() convert C ops representing lines to L ops... i think?
  mouseMove(e) {
    let rect = livecanvas.getBoundingClientRect();
    let pt = [e.clientX-rect.left, e.clientY-rect.top];

    if (this.state == _ON) {
      if(this.ops[this.ops.length-1][0]=="M"){
        this.cpoint = [pt[0], pt[1]]; //tmp pt
        this.liverender();
      }
      //complicated, upconvert line operation to curve operation
      else if(this.ops[this.ops.length-1][0]=="L"){
        let thisop = this.ops[this.ops.length-1];
        let prevop = this.ops[this.ops.length-2];
        let thispt = this.getOpEndPoint(thisop); //line endpoint
        let prevpt = this.getOpEndPoint(prevop); //line startpoint
        let reflpt = reflectPoint(thispt, pt);
        this.ops[this.ops.length-1]=["C",
                                     prevpt[0], prevpt[1],
                                     reflpt[0], reflpt[1],
                                     thispt[0], thispt[1]];
        this.cpoint = [pt[0], pt[1]]; //tmp pt
        this.liverender();
      }
      else if(this.ops[this.ops.length-1][0]=="C"){
        let thisop = this.ops[this.ops.length-1];
        let thispt = this.getOpEndPoint(thisop); //line endpoint
        let reflpt = reflectPoint(thispt, pt);
        this.ops[this.ops.length-1]=["C",
                                     thisop[1], thisop[2],
                                     reflpt[0], reflpt[1],
                                     thispt[0], thispt[1]];
        this.cpoint = [pt[0], pt[1]]; //tmp pt
        this.liverender();
      }
    }
    else if(this.state == _MOVE) {
      let firstHit = this.opselected[0];
      // vertex move -------------------------------------------------
      if(firstHit[2]=='v') {
        let idx = firstHit[0];
        let ptidx = firstHit[1];
        let oldpt = [this.ops[idx][2*ptidx + 1],
                     this.ops[idx][2*ptidx + 2]];
        let delta = [pt[0]-oldpt[0], pt[1]-oldpt[1]];
        this.ops[idx][2*ptidx + 1] = pt[0];
        this.ops[idx][2*ptidx + 2] = pt[1];

        for(let hit of this.opselected.slice(1)){
          let idx = hit[0];
          let ptidx = hit[1];
          let pttype = hit[2];
          if(pttype == "c") {
            this.ops[idx][2*ptidx + 1] += delta[0];
            this.ops[idx][2*ptidx + 2] += delta[1];
          }
          else if(pttype == "t") {
            this.cpoint[0] += delta[0];
            this.cpoint[1] += delta[1];
          }
        }
        this.liverender();
      }
      // control point move -------------------------------------------
      // must maintain continuity
      else if(firstHit[2]=='c') {
        let idx = firstHit[0];
        let ptidx = firstHit[1];
        this.ops[idx][2*ptidx + 1] = pt[0];
        this.ops[idx][2*ptidx + 2] = pt[1];
        if(this.opselected.length===2){
          let secondHit = this.opselected[1];
          if(secondHit[2]=='c') {
            let idx2 = secondHit[0];
            let ptidx2 = secondHit[1];
            let oppositept = [this.ops[idx2][2*ptidx2 + 1],
                              this.ops[idx2][2*ptidx2 + 2]];
            let centerpt = [this.ops[Math.min(idx,idx2)][5],
                            this.ops[Math.min(idx,idx2)][6]];
            let reflectVec = normalize(reflectPoint([0,0],sub2(pt, centerpt)));
            let alpha = l2norm(sub2(oppositept, centerpt));
            let newpt = add2(scalar2(reflectVec,alpha), centerpt);
            this.ops[idx2][2*ptidx2 + 1] = newpt[0];
            this.ops[idx2][2*ptidx2 + 2] = newpt[1];
          }
          else if(secondHit[2]=='t') {
            let oppositept = this.cpoint;
            let centerpt = [this.ops[this.ops.length-1][5],
                            this.ops[this.ops.length-1][6]];
            let reflectVec = normalize(reflectPoint([0,0],sub2(pt, centerpt)));
            let alpha = l2norm(sub2(oppositept, centerpt));
            let newpt = add2(scalar2(reflectVec,alpha), centerpt);
            this.cpoint[0] = newpt[0];
            this.cpoint[1] = newpt[1];
          }
        }
        this.liverender();
      }
      // control point move on dangling point --------------------------------
      else if(firstHit[2]=='t') {
        this.cpoint = pt;
        if(this.opselected.length===2){
          let secondHit = this.opselected[1];
          let idx2 = secondHit[0];
          let ptidx2 = secondHit[1];
          let oppositept = [this.ops[idx2][2*ptidx2 + 1],
                            this.ops[idx2][2*ptidx2 + 2]];
          let centerpt = [this.ops[idx2][5], this.ops[idx2][6]];
          let reflectVec = normalize(reflectPoint([0,0],sub2(pt, centerpt)));
          let alpha = l2norm(sub2(oppositept, centerpt));
          let newpt = add2(scalar2(reflectVec,alpha), centerpt);
          this.ops[idx2][2*ptidx2 + 1] = newpt[0];
          this.ops[idx2][2*ptidx2 + 2] = newpt[1];
        }
        this.liverender();
      }
    }
  }

  mouseUp(e) {
    this.state = _OFF;
    this.opselected = [];
    this.liverender();
  }

  mouseLeave(e) {
    this.exit();
  }

  keyDown(e) {
    if(e.code == "Enter"){
      this.state = _OFF;
      this.exit();
    } else if(e.code=="Escape"){
      this.cancel();
    } else if(e.code=="KeyD"){
      if(this.ops.length > 1 &&
         this.state == _OFF) {
        this.ops.pop();
        this.liverender();
      }
    }
  }

  commit() {
    gS.cmdstack.push( new BezierOp(this.ops) );
    rerender(ctx);
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  cancel() {
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
    this.state = _INIT;
    this.ops = [];
  }

  exit(){
    if(this.state==_OFF) { // remove conditional?
      this.commit();
      this.ops = [];
      this.opselected = [];
      this.cpoint = [];
      this.state = _INIT;
    }
  }
}


// Draw Circles
//------------------------------------------------------------------------------
class CircleOp {
  constructor(center, radius) {
    this.center = center;
    this.radius = radius;
  }

  render(ctx){
    for (let af of affineset) {
      const Tc1 = af.on(this.center.x, this.center.y);
      const Tr = this.radius; //XXX: not true for scaling trafos! fix!
      ctx.beginPath();
      ctx.arc(Tc1[0], Tc1[1], Tr, 0, 2*Math.PI);
      ctx.stroke();
      ctx.fill();
    }
  }

  serialize(){
    return ["circle", this.center, this.radius];
  }

  deserialize(data){
    return new CircleOp(data[1], data[2]);
  }
}

class CircleTool {
  constructor() {
    this.center = {};
    this.radius = 0;
    this.on = false;
    this.drawInterval = 0;
  }

  liverender() {
    lctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let af of affineset) {
      const Tc1 = af.on(this.center.x, this.center.y);
      const Tr = this.radius; //XXX: not true for scaling trafos! fix!
      lctx.beginPath();
      lctx.arc(Tc1[0], Tc1[1], Tr, 0, 2*Math.PI);
      lctx.stroke();
      lctx.fill();
    }
  }

  commit() {
    gS.cmdstack.push( new CircleOp(this.center, this.radius) );
    rerender(ctx);
    lctx.clearRect(0, 0, livecanvas.width, livecanvas.height);
  }

  mouseDown(e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    this.center = { x: e.clientX - rect.left,
                   y: e.clientY - rect.top};
    this.on = true;
  }

  mouseMove(e) {
    if (this.on) {
      if (this.drawInterval <= 0) {
        var rect = canvas.getBoundingClientRect();
        var tmp = { x: e.clientX - rect.left,
                    y: e.clientY - rect.top};
        this.radius =
          Math.sqrt(Math.pow(this.center.x-tmp.x, 2) + Math.pow(this.center.y-tmp.y, 2));
        this.liverender();
        this.drawInterval = 1;
      }
      this.drawInterval--;
    }
  }

  mouseUp(e) {
    this.on = false;
    this.commit();
    this.center = {};
    this.radius = 0;
  }
}



// Set up Globals and UI for calling into Drawing Tools
//------------------------------------------------------------------------------
var drawTools = {
  line: new FancyLineTool(),
  circle: new CircleTool(),
  pencil: new PencilTool(),
  grid: new GridTool(),
  poly: new PolyTool(),
  bezier: new BezierTool()
};

var curTool = "line";

var changeTool = function(toolName){
  let oldTool = drawTools[curTool];
  if('exit' in oldTool){
    oldTool.exit();
  }
  // update global
  curTool = toolName;
  let newTool = drawTools[toolName];
  if('enter' in newTool){
    newTool.enter();
  }
};

//HACK : need to vueify the rest of the UI...
var exclusiveClassToggle = function(target, className){
  let _els = document.getElementsByClassName(className);
  for(let _el of _els){
    _el.classList.remove(className);
  }
  target.classList.add(className);
};

// tmp: directly link selectors to changeTool
document.getElementById("linetool").onmousedown   = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("line"); };
document.getElementById("circletool").onmousedown = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("circle"); };
document.getElementById("penciltool").onmousedown = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("pencil"); };
document.getElementById("showgrid").onmousedown   = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("grid"); };
document.getElementById("polytool").onmousedown   = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("poly"); };
document.getElementById("beziertool").onmousedown   = function(e) {
  exclusiveClassToggle(e.target, "tool-selected");
  changeTool("bezier"); };


// Set up Save SVG / Save PNG
//------------------------------------------------------------------------------
// XXX: this can take a long damn time with a complicated scene! At minimum should
// do redraws with smaller grid Nx,Ny by default or just restrict SVG export to
// tile?
document.getElementById("saveSVG").onmousedown = function(e) {
  // canvas2svg fake context:
  var C2Sctx = new C2S(canvas.width, canvas.height);
  rerender(C2Sctx);
  //serialize the SVG
  var mySerializedSVG = C2Sctx.getSerializedSvg(); // options?
  //save text blob as SVG
  var blob = new Blob([mySerializedSVG], {type: "image/svg+xml"});
  saveAs(blob, "eschersketch.svg");
};

// TODO : allow arbitrary upscaling of canvas pixel backing density using
//        setCanvasPixelDensity
document.getElementById("savePNG").onmousedown = function(e) {
    canvas.toBlob(blob => saveAs(blob, "eschersketch.png"));
};



// should be "reset"
var initState = function() {
  gS.cmdstack.push(new ColorOp(
    "stroke",
    gS.strokecolor.r,
    gS.strokecolor.g,
    gS.strokecolor.b,
    gS.strokecolor.a));

  gS.cmdstack.push(new ColorOp(
    "fill",
    gS.fillcolor.r,
    gS.fillcolor.g,
    gS.fillcolor.b,
    gS.fillcolor.a));

  gS.cmdstack.push(new StyleOp({
    lineCap: "butt",
    lineJoin: "round",
    miterLimit: 10.0,
    lineWidth: 1.0}));

  gS.cmdstack.push(new SymmOp(
    gConstants.INITSYM,
    _.clone(gS.gridstate)));

  // set global undo boundary so these initial
  // settings don't get lost (needed for drawstate stability
  // during reset on redraw)
  undo_init_bound = 4;

  rerender(ctx);
};


var initGUI = function() {

  canvas = document.getElementById("sketchrender");
  canvas.width = gConstants.CANVAS_WIDTH;
  canvas.height = gConstants.CANVAS_HEIGHT;
  pixelratio = pixelFix(canvas);
  ctx = canvas.getContext("2d");

  livecanvas = document.getElementById("sketchlive");
  livecanvas.width = gConstants.CANVAS_WIDTH;
  livecanvas.height = gConstants.CANVAS_HEIGHT;
  pixelFix(livecanvas);
  lctx = livecanvas.getContext("2d");

  livecanvas.onmousedown  = dispatchMouseDown;
  livecanvas.onmouseup    = dispatchMouseUp;
  livecanvas.onmousemove  = dispatchMouseMove;
  livecanvas.onmouseleave = dispatchMouseLeave;
  document.getElementsByTagName("body")[0].onkeydown = dispatchKeyDown;

  initState();

};

initGUI();