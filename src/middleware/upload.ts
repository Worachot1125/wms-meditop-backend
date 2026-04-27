import multer from "multer";
const storage = multer.memoryStorage();
export const upload = multer({ storage });


export const uploadUserFile = upload.single("user_img");

export const uploadLocationFile = upload.single("location_img");
