import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/config/google-tiles", (_req, res) => {
  const key = process.env.GOOGLE_3D_TILES;
  if (!key) {
    res.status(404).json({ error: "GOOGLE_3D_TILES is not configured" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=300");
  res.json({ key });
});

export default router;
