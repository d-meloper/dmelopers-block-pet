import type { Camera, Mesh, Object3D, Scene, WebGLRenderer } from 'three'

/** Prove that this pet submitted a draw, even in a hidden or fully transparent window. */
export function renderPetHealthFrame(
  renderer: Pick<WebGLRenderer, 'getContext' | 'info' | 'render'>,
  scene: Scene,
  camera: Camera,
  pet: Object3D,
): boolean {
  const gl = renderer.getContext()
  if (gl.isContextLost()) return false
  let petDrawn = false
  const restore: Array<() => void> = []
  pet.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')?.count) return
    const before = mesh.onBeforeRender
    const after = mesh.onAfterRender
    const culled = mesh.frustumCulled
    let calls = 0
    // User pan may legitimately put the pet outside the viewport. Keep that
    // camera and all opacity/visibility settings, but submit one clipped draw.
    mesh.frustumCulled = false
    mesh.onBeforeRender = function (...args) {
      before.apply(this, args)
      calls = renderer.info.render.calls
    }
    mesh.onAfterRender = function (...args) {
      petDrawn ||= renderer.info.render.calls > calls
      after.apply(this, args)
    }
    restore.push(() => {
      mesh.onBeforeRender = before
      mesh.onAfterRender = after
      mesh.frustumCulled = culled
    })
  })
  try {
    renderer.render(scene, camera)
    return petDrawn && !gl.isContextLost() && gl.getError() === gl.NO_ERROR
  } finally {
    for (const reset of restore) reset()
  }
}
