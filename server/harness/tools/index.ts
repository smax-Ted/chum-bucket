import { edit, read, write } from "./fs";
import { getFigma } from "./get-figma";

export const localTools = [getFigma, read, write, edit];
