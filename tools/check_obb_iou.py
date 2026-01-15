import json, math
import numpy as np

m=json.load(open("debug/debug_manifest.json"))
d=m.get("detectionsOriginal") or m.get("detectionsFiltered") or []
# Use the first 30 boxes (already NMS'd). We want overlap in pre-NMS.
# So instead: re-run decode_one.py with aabb mode and topk high but NO NMS.
# If your script can't do "no nms", this will still catch obvious bugs by comparing pairs.

def corners(cx,cy,w,h,a):
    ca, sa = math.cos(a), math.sin(a)
    dx, dy = w/2.0, h/2.0
    pts = [(-dx,-dy),(dx,-dy),(dx,dy),(-dx,dy)]
    out=[]
    for x,y in pts:
        out.append((cx + x*ca - y*sa, cy + x*sa + y*ca))
    return out

def area(poly):
    s=0.0
    for i in range(len(poly)):
        x1,y1=poly[i]
        x2,y2=poly[(i+1)%len(poly)]
        s += x1*y2 - x2*y1
    return abs(s)*0.5

# Simple Sutherland–Hodgman clip against convex quad
def clip(subject, clipper):
    def inside(p, a, b):
        return (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]) >= 0
    def intersection(s, e, a, b):
        dc = (a[0]-b[0], a[1]-b[1])
        dp = (s[0]-e[0], s[1]-e[1])
        n1 = a[0]*b[1] - a[1]*b[0]
        n2 = s[0]*e[1] - s[1]*e[0]
        denom = dc[0]*dp[1] - dc[1]*dp[0]
        if abs(denom) < 1e-9:
            return e
        x = (n1*dp[0] - n2*dc[0]) / denom
        y = (n1*dp[1] - n2*dc[1]) / denom
        return (x,y)

    out = subject
    for i in range(len(clipper)):
        inp = out
        out = []
        if not inp:
            break
        A = clipper[i]
        B = clipper[(i+1)%len(clipper)]
        S = inp[-1]
        for E in inp:
            if inside(E, A, B):
                if not inside(S, A, B):
                    out.append(intersection(S, E, A, B))
                out.append(E)
            elif inside(S, A, B):
                out.append(intersection(S, E, A, B))
            S = E
    return out

def iou_obb(b1,b2):
    p1 = corners(*b1)
    p2 = corners(*b2)
    inter_poly = clip(p1, p2)
    if len(inter_poly) < 3:
        return 0.0
    a1 = area(p1)
    a2 = area(p2)
    ai = area(inter_poly)
    return ai / (a1 + a2 - ai + 1e-9)

# pick 25 highest score boxes from detectionsOriginal
d = sorted(d, key=lambda x: -x["score"])[:25]
boxes=[(x["cx"],x["cy"],x["w"],x["h"],x["angle"]) for x in d]

ious=[]
for i in range(len(boxes)):
    for j in range(i+1,len(boxes)):
        ious.append(iou_obb(boxes[i], boxes[j]))
ious=np.array(ious)
print("pairs:", len(ious))
print("max_iou:", float(ious.max()) if len(ious) else None)
print("p95:", float(np.quantile(ious,0.95)) if len(ious) else None)
print("p50:", float(np.quantile(ious,0.50)) if len(ious) else None)
print("nonzero:", int((ious>1e-6).sum()))
