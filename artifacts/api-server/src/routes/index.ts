import { Router, type IRouter } from "express";
import healthRouter from "./health";
import proxyRouter from "./proxy";
import cctvRouter from "./cctv";
import configRouter from "./config";

const router: IRouter = Router();

router.use(configRouter);
router.use(healthRouter);
router.use(proxyRouter);
router.use(cctvRouter);

export default router;
