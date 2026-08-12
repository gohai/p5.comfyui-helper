# p5.comfyui-helper.js

A library for p5.js which adds support for interacting with ComfyUI, using its API. It provides the following features:

* Submit ComfyUI workflows (saved in API format) from p5.js
* Modify various aspects of the workflow from within JavaScript
* Submit images or p5 drawing surfaces as inputs to workflows (e.g. for img2img, ...)
* Easy to use API that supports multiple outputs as well
* Works with promises or callbacks

## Reference

- [Demo](#demo)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Getting started](#getting-started)
- [Examples](examples/)

## Demo

[Demo video](https://drive.google.com/file/d/1PmOk6OqwHU_6oGd50JQBHdjLdV_oLrdt/view?usp=sharing)

## Prerequisites

* Either a self-hosted [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance (tested with v0.4.51), or a [Comfy Cloud](https://www.comfy.org/cloud) subscription (Standard, Creator or Pro tier; the Free tier doesn't include API access)
* If you are running your own ComfyUI installation:
    * Make sure to start Comfy with the following arguments: ```--listen 0.0.0.0 --enable-cors-header '*'```
    * If the site you will be accessing Comfy from uses HTTPS, you will need to provision a certificate, and load it into ComfyUI with ```--tls-keyfile privkey.pem --tls-certfile fullchain.pem```. This is needed if you want to make use of the p5.js web editor.
* If you are using Comfy Cloud:
    * Get an API key from [platform.comfy.org](https://platform.comfy.org) (see [Getting an API Key](https://docs.comfy.org/development/api-development/getting-an-api-key))

## Setup

[Setup video](https://drive.google.com/file/d/16InuWI4nJpyUtFGbS6dUBLVXZadqM_OS/view?usp=drive_link)

* Install _comfyui-tooling-nodes_ (available to install via the ComfyUI Manager, or [manually](https://github.com/Acly/comfyui-tooling-nodes?tab=readme-ov-file#installation))
* Enable _Dev Mode_ in ComfyUI's setting (via the cog icon on the website), for the "Save (API format)" button to show.

## Getting started

Include the following line in the `head` section of your HTML:
```
<script src="https://unpkg.com/@gohai/p5.comfyui-helper@^1/libraries/p5.comfyui-helper.js"></script>
```

or, download and use a local copy of the [library file](https://github.com/gohai/p5.comfyui-helper/blob/main/libraries/p5.comfyui-helper.js) like so:

```
<script src="p5.comfyui-helper.js"></script>
```

#### Connecting to the ComfyUI instance

Create a global variable, and set up the `ComfyUiP5Helper` like so. The first argument is the URL you're using to access ComfyUI (with or without a slash at the end).

```
let comfy;

function setup() {
  comfy = new ComfyUiP5Helper("https://your.comfyui.instance:8188");
```

#### Connecting to Comfy Cloud

To use [Comfy Cloud](https://www.comfy.org/cloud) instead of a self-hosted instance, pass your API key as a second argument:

```
let comfy;

function setup() {
  comfy = new ComfyUiP5Helper("https://cloud.comfy.org", "your-api-key");
```

**This alone won't work in a browser.** `cloud.comfy.org` doesn't allow browser pages to call its API directly (no CORS headers are returned for any origin, including the p5.js Web Editor), so requests made straight from a sketch will fail. To use Comfy Cloud from a p5.js sketch, deploy the small CORS proxy included in [`proxy/`](proxy/) (a few minutes, free), and point `base_url` at your deployed proxy URL instead — everything else about the call stays the same:

```
comfy = new ComfyUiP5Helper("https://your-proxy.workers.dev", "your-api-key");
```

The proxy doesn't hold or see anyone's credentials beyond relaying them, so this also works well for a group of people (e.g. a workshop) sharing one proxy URL while each using their own API key and credits. See [`proxy/README.md`](proxy/README.md) for setup.

Everything below (loading workflows, running them, receiving results, image inputs) works the same way regardless of whether you're connected to a self-hosted instance or Comfy Cloud (via the proxy).

Keep in mind that the Cloud API is billed against your subscription's monthly credits (the same pool the Comfy Cloud web UI draws from), and that concurrent job limits apply depending on your tier. Never commit your API key to version control.

#### Loading a workflow

Save the desired workflow in ComfyUI by clicking the "Save (API Format)" button in the tool bar. (If you don't see this button, make sure that _Dev Mode_ is enabled in the settings accessible via the cog icon.)

This creates a JSON file that can be easily added to your p5.js project (e.g. by uploading it in the p5.js Web Editor), and loaded like so:

```
let workflow;

function preload() {
  workflow = loadJSON("workflow_api.json");
  console.log("workflow is", workflow);
}
```

The keys in this object correspond to the _#_ number ComfyUI shows at the top right of each node.

![example node](doc/example_node.png)

E.g. to change the seed of this KSampler node from within JavaScript, we'd do:

```
workflow[3].inputs.seed = random(999999);
```

#### Running a workflow

Submitting a workflow to ComfyUI's queue is as easy as calling its `run` method.

You can use this in two ways: either by passing a callback function as the second parameter.

```
comfy.run(workflow, gotImage);
```

This will call a function gotImage once the result are available:

```
function gotImage(results, error) {
  // ...
}
```

Alternatively, you can also use the `await` keyword to wait for the `run` method to eventually return the results:

```
let results = await comfy.run(workflow);
```

You can also add a third (optional) parameter to receive status updates while the workflow is running:

```
comfy.run(workflow, gotImage, gotStatus);

function gotStatus(status){
  console.log(status);
}
```

#### Receiving results

The `results` contains an array of objects, each with a `src` property and a `node` property. Use `src` with `loadImage()` to turn this into an image-type variable to be used for drawing.

```
let img;

function gotImage(results, error) {
  console.log(results);

  if (results.length > 0) {
    img = loadImage(results[0].src);
  }
}
``` 

The `node` property contains the id of the node that created the image.

Call `loadImage()` on a `src` before starting the next run: when using Comfy Cloud the results are held in browser memory, and those of the previous run are released once a new one starts (otherwise a sketch that generates continuously would keep every image it ever received).

#### Image inputs

Various types of workflows, such as image-to-image or inpainting, make use of existing images as part of the image generation.

The `image()` method uploads an image (or drawing surface) from p5.js, and returns the filename to use for it in the workflow. Assign it to the `image` input of any "Load Image" node, in place of the file that node would otherwise load from disk.

E.g.: the following image-to-image workflow has a "Load Image" as #10

```
let srcImg;

function preload() {
  srcImg = loadImage("example.png");
}

// ...
workflow[10].inputs.image = comfy.image(srcImg);
```

```
let srcImg;

function setup() {
  createCanvas(512, 512);
  srcImg = createGraphics(width, height);
  srcImg.background(0);
  srcImg.fill("yellow");
  srcImg.circle(width/2, height/2, 100);

  // ...
  workflow[10].inputs.image = comfy.image(srcImg);
}
```

Images are uploaded as PNG, so anything you `erase()` stays transparent — which is what workflows that use the alpha channel as an inpainting mask need. Pass `comfy.image(srcImg, "image/jpeg")` for smaller (but opaque) uploads.
