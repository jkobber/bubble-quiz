import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import { parse } from 'csv-parse/sync'

const prisma = new PrismaClient()

async function main() {
  const filePath = path.join(process.cwd(), 'questions.csv')
  
  if (!fs.existsSync(filePath)) {
    console.log('No questions.csv found at', filePath)
    return
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8')
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true
  })

  console.log(`Found ${records.length} records. Importing...`)
  
  // Find admin or first user to assign ownership
  const creator = await prisma.user.findFirst({ where: { role: 'ADMIN' } }) || await prisma.user.findFirst()
  if (!creator) {
      console.error('No user found to assign questions to.')
      return
  }

  for (const record of records) {
    // Expected Columns: Text,Option0,Option1,Option2,Option3,CorrectIndex,Explanation,Tags
    const { Text, Option0, Option1, Option2, Option3, CorrectIndex, Explanation, Tags } = record as any;
    
    // Construct Options
    const options = [Option0, Option1, Option2, Option3].filter(Boolean)
    
    // Create Question
    const q = await prisma.question.create({
      data: {
        text: Text,
        options: JSON.stringify(options),
        correctIndex: parseInt(CorrectIndex) || 0,
        explanation: Explanation || null,
        creatorId: creator.id,
        isLocked: false // Public by default
      }
    })

    // Handle Tags (comma separated)
    if (Tags) {
       const tags = Tags.split(',').map((t: string) => t.trim())
       for (const tagName of tags) {
          if (!tagName) continue
          
          let tag = await prisma.tag.findUnique({ where: { name: tagName } })
          if (!tag) {
             tag = await prisma.tag.create({ 
                 data: { 
                    name: tagName, 
                    slug: tagName.toLowerCase().replace(/\s+/g, '-'),
                    icon: 'Tag' 
                 } 
             })
          }
          
          await prisma.questionTag.create({
             data: {
                questionId: q.id,
                tagId: tag.id
             }
          })
       }
    }
  }

  console.log('Import completed.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
