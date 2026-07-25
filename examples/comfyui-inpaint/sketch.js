// this example workflow expects 512-inpainting-ema.safetensors to be installed
// based on 

// XXX: this example does not seem to work with latest ComfyUI

let workflow;
let comfy;
let bg;
let srcImg;
let resImg;

function preload() {
  workflow = loadJSON("workflow_api.json");
  bg = loadImage("yosemite.jpg");
}

function setup() {
  createCanvas(1024, 683);
  pixelDensity(1);
  srcImg = createGraphics(width, height);

  comfy = new ComfyUiP5Helper("https://your.comfyui.instance:8188");
  console.log("workflow is", workflow);

  let button = createButton("start generating");
  button.mousePressed(requestImage);
}

function requestImage() {
  // replace the LoadImage node with our source image
  workflow[20] = comfy.image(srcImg);
  // update the seed
  workflow[3].inputs.seed = workflow[3].inputs.seed + 1;
  // reduce the number of steps (to make it faster)
  workflow[3].inputs.steps = 10;

  comfy.run(workflow, gotImage);
}

function gotImage(results, err) {
  // data is an array of outputs from running the workflow
  console.log("gotImage", results);

  // you can load them like so
  if (results.length > 0) {
    resImg = loadImage(results[0].src);
  }

  // automatically run again
  requestImage();
}

function draw() {
  // draw a scene into the source image to use for generation
  srcImg.image(bg, 0, 0);
  // burn a "hole" into the image
  srcImg.erase();
  srcImg.circle(mouseX, mouseY, 200);
  srcImg.noErase();

  background(255);
  // checkerboard pattern (decoration)
  for (let y = 0; y < height; y += 10) {
    for (let x = 0; x < width; x += 10) {
      noStroke();
      if ((x + y) / 10 % 2 === 0) {
        fill(255);
      } else {
        fill(204);
      }
      rect(x, y, 10, 10);
    }
  }
  image(srcImg, 0, 0);

  //if we have an image, put it onto the canvas
  if (resImg) {
    image(resImg, 0, 0, width, height);
  }
}
