const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose');
require('dotenv').config()
const bcrypt = require('bcrypt');
let User = require('./schemas/user');
const { nanoid } = require('nanoid');
const jwt = require('jsonwebtoken');
const aws = require('aws-sdk');
let Blog = require('./schemas/blog');
const bodyParser = require("body-parser")



const app = express();

app.use(express.json());
app.use(cors())
app.use(bodyParser.urlencoded({ extended: true }));

let emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; 
let passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; 

const generateUsername = async (email) => {
    let username = email.split("@")[0];

    let isUsernameUnique = await User.exists({ "personal_info.username": username }).then((result) => result)

    isUsernameUnique ? username += nanoid().substring(0, 5) : ""

    return username
}

const verifyJWT = (req, res, next) => {

    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(" ")[1]

    if(token == null) {
        return res.status(401).json({ error: "No access token" })
    }

    jwt.verify(token, process.env.SECRET_ACCESS_KEY, (err, user) => {
        if(err) {
            return res.status(403).json({ error: "Access token is invalid" })
        }

        req.user = user.id
        next()
    })

}

const formatData = (user) => {
    const access_token = jwt.sign({ id: user._id }, process.env.SECRET_ACCESS_KEY)

    return {
        access_token,
        profile_img: user.personal_info.profile_img,
        username: user.personal_info.username,
        fullname: user.personal_info.fullname
    }
}

mongoose.connect(process.env.MONGODB_URI, {
    autoIndex: true
})

const s3 = new aws.S3({
    region: 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
})

const generateUpload = async () => {
    const date = new Date()
    const image = `${nanoid().substring(0, 5)}-${date.getTime()}.jpeg`

    return await s3.getSignedUrlPromise('putObject', {
        Bucket: 'blogverse-website',
        Key: image,
        Expires: 1000,
        ContentType: "image/type"
    })
}

app.post("/signup", (req, res) => {
    
    let { fullname, email, password } = req.body;

    if(fullname.length < 3) {
        return res.status(403).json({"error" : "Full name must be atleast 3 letters long"})
    }

    if(!email.length) {
        return res.status(403).json({"error" : "Enter Email"})
    }

    if(!emailRegex.test(email)) {
        return res.status(403).json({"error" : "Invalid Email"})
    }

    if(!passwordRegex.test(password)) {
        return res.status(403).json({"error" : "Invalid Password"})
    }

    bcrypt.hash(password, 10, (err, hashed_pw) => {
        
        let username = email.split("@")[0]

        let user = new User({
            personal_info: { fullname, email, password: hashed_pw, username }
        })

        user.save().then((u) => {
            return res.status(200).json(formatData(u))
        })
        .catch(err => {

            if(err.code == 11000) {
                return res.status(500).json({"error": "Email already exists"})    
            }

            return res.status(500).json({"error": err.message})
        })

    })

})

app.post("/signin", (req, res) => {

    let { email, password } = req.body

    User.findOne({ "personal_info.email": email })
    .then((user) => {
        if(!user) {
            throw 'error'
        }

        bcrypt.compare(password, user.personal_info.password, (err, result) => {
            if(err) {
                return res.status(403).json({ "error": "Error occured while login. Please try again" })
            }

            if(!result) {
                return res.status(403).json({ "error": "Incorrect password" })
            }else {
                return res.status(200).json(formatData(user))
            }
        })
    })
    .catch(err => {
        console.log(err);
        return res.status(403).json({"error": "Email not found"})        
    })

})

app.get('/get-upload-url', (req, res) => {
    generateUpload().then(url => res.status(200).json({uploadUrl: url}))
    .catch(err => {
        console.log(err.message);
        return res.status(500).json({error: err.message})
    })
})

app.post('/create-blog', verifyJWT, (req, res) => {
    
    let authorId = req.user

    let { title, desc, banner, tags, content, draft } = req.body

    if(!title.length) {
        return res.status(403).json({ error: "You must provide a title to publish the blog" })
    }

    if(!desc.length) {
        return res.status(403).json({ error: "You must provide a description under 200 characters" })
    }
    
    if(!banner.length) {
        return res.status(403).json({ error: "You must provide a banner to publish the blog" })
    }

    if(!content.blocks.length) {
        return res.status(403).json({ error: "You must provide a banner to publish the blog" })
    }

    tags = tags.map(tag => tag.toLowerCase())

    let blogId = title.replace(/[^a-zA-Z0-9]/g, ' ').trim() + nanoid()
    
    let blog = new Blog({
        title, desc, banner, content, tags, author: authorId, blogId, draft: Boolean(draft)
    })

    blog.save().then(blog => {

        let increment = draft ? 0 : 1

        User.findOneAndUpdate({ _id: authorId }, { $inc : { "account_info.total_posts" : increment }, $push :{ "blogs": blog._id } })
        .then(user => {
            return res.status(200).json({ id: blog.blog_id })
        })
        .catch(err => {
            return res.status(500).json({ error: "Failed to update the total posts" })
        })

    })
    .catch(err => {
        return res.status(500).json({ error: err })
    })   

})

app.get('/latest-blogs', (req, res) => {
    let maxLimit = 5

    Blog.find({ draft: false })
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "publishedAt": -1 })
    .select("blog_id title desc banner activity tags publishedAt -_id")
    .limit(maxLimit)
    .then(blogs => {
        return res.status(200).json({blogs})
    })
    .catch(err => {
        return res.status(500).json({ error: err.message })
    })
})

app.get('/trending-blogs', (req, res) => {
    let maxLimit = 5

    Blog.find({ draft: false })
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "activity.total_read": -1, "activity.total_likes": -1, "publishedAt": -1 })
    .select("blog_id title desc banner activity tags publishedAt -_id")
    .limit(maxLimit)
    .then(blogs => {
        return res.status(200).json({blogs})
    })
    .catch(err => {
        return res.status(500).json({ error: err.message })
    })
})

app.post('/search-blog-posts', (req, res) => {
    let { tag, query, page } = req.body

    let findQuery; 

    if(tag) {
        findQuery = { tags: tag, draft: false }
    } else {
        findQuery = { draft: false, title: new RegExp(query, 'i') }
    }

    let maxLimit = 2

    Blog.find(findQuery)
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "publishedAt" : -1 })
    .select("blog_id title desc banner activity tags publishedAt -_id")
    .skip((page - 1) * maxLimit)
    .limit(maxLimit)
    .then(blogs => {
        return res.status(200).json({ blogs })
    })
    .catch(err => {
        return res.status(403).json({ error: err.message })
    })
})

app.get('/search-blog-counts', (req, res) => {
    Blog.countDocuments(findQuery)
    .then(count => {
        return res.status(200).json({ totalDocs:count })
    })
    .catch(err => {
        console.log(err.message);
        return res.status(500).json({ error: err.message })
        
    })
})

// Start the server
app.listen(3000, () => {
    console.log(`Server is running on port 3000`);
});