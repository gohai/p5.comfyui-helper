// this example workflow expects sdxl_lightning_2step.safetensors to be installed
// based on https://comfyanonymous.github.io/ComfyUI_examples/img2img

let workflow;
let comfy;
let srcImg;
let resImg;

function preload() {
  workflow = loadJSON("workflow_api.json");
}

function setup() {
  createCanvas(512, 512);
  pixelDensity(1);
  srcImg = createGraphics(width, height);

  comfy = new ComfyUiP5Helper("https://your.comfyui.instance:8188");
  console.log("workflow is", workflow);

  let button = createButton("start generating");
  button.mousePressed(requestImage);
}

function requestImage() {
  // point the LoadImage node at our source image
  workflow[10].inputs.image = comfy.image(srcImg);
  // replace the prompt
  workflow[6].inputs.text = "idylic beach scene with a white volleyball";
  // randomize the seed
  workflow[3].inputs.seed = workflow[3].inputs.seed + 1;

  comfy.run(workflow, gotImage);
}

function gotImage(data, err) {
  // data is an array of outputs from running the workflow
  console.log("gotImage", data);

  if (err) {
    // don't immediately try again, or a persistent error turns into a tight
    // loop of requests (which costs credits when running against the cloud)
    console.warn("Not retrying:", err);
    return;
  }

  // you can load them like so
  if (data.length > 0) {
    resImg = loadImage(data[0].src);
  }

  // automatically run again
  requestImage();
}

function draw() {
  // draw a scene into the source image to use for generation
  srcImg.background(255, 150, 50); // sky
  srcImg.fill(0, 50, 150); // water
  srcImg.noStroke();
  srcImg.rect(0, height / 2, width, height / 2);
  srcImg.fill(255); // volleyball
  srcImg.noStroke();
  srcImg.ellipse(mouseX, mouseY, 150, 150);

  background(255);
  image(srcImg, 0, 0);
  //if we have an image, put it onto the canvas
  if (resImg) {
    image(resImg, 0, 0, width, height);
  }
}
