# Headless Blender render of STL files with a wireframe overlay, for visual checks.
#   blender -b --factory-startup --python tools/render-stl.py -- out.png "az,el,tx,ty,tz,dist,lens" a.stl [b.stl@dx ...]
# az/el in degrees around the target (tx,ty,tz); lens < 0 renders orthographic with ortho_scale = -lens.
import bpy, sys, math, mathutils
argv = sys.argv[sys.argv.index('--')+1:]
out, view, stls = argv[0], argv[1], argv[2:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'OBJECT'
sc.display.shading.show_cavity = False
sc.render.resolution_x = 1000; sc.render.resolution_y = 800
sc.render.film_transparent = False
w = bpy.data.worlds.new('w'); sc.world = w
cols = [(0.75,0.78,0.8,1),(0.8,0.7,0.95,1),(0.7,0.9,0.75,1)]
offs = 0
for i, s in enumerate(stls):
    path, _, dx = s.partition('@')
    bpy.ops.wm.stl_import(filepath=path)
    o = bpy.context.selected_objects[0]
    o.color = cols[i % 3]
    if dx: o.location.x += float(dx)
    wf = o.copy(); wf.data = o.data; bpy.context.collection.objects.link(wf)
    m = wf.modifiers.new('wf', 'WIREFRAME'); m.thickness = 0.02; m.use_replace = True; m.use_even_offset = False
    wf.color = (0.1,0.1,0.15,1)
az, el, tx, ty, tz, dist, lens = [float(x) for x in view.split(',')]
cam = bpy.data.cameras.new('c'); co = bpy.data.objects.new('c', cam); sc.collection.objects.link(co); sc.camera = co
if lens < 0:
    cam.type = 'ORTHO'; cam.ortho_scale = -lens
else:
    cam.lens = lens
cam.clip_end = 10000; cam.clip_start = 0.01
a, e = math.radians(az), math.radians(el)
t = mathutils.Vector((tx,ty,tz))
co.location = t + dist*mathutils.Vector((math.cos(e)*math.cos(a), math.cos(e)*math.sin(a), math.sin(e)))
d = t - co.location
co.rotation_euler = d.to_track_quat('-Z','Y').to_euler()
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
