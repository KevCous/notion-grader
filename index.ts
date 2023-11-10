import { Client } from "@notionhq/client";
import { AppendBlockChildrenParameters, AppendBlockChildrenResponse } from "@notionhq/client/build/src/api-endpoints";
import { config } from "dotenv";
import fs from "fs";

config();
const notion = new Client({ auth: process.env.NOTION_KEY });

async function queryDatabase(database_id: string) {
    let cursor = undefined;
    let resultsAll: any[] = [];
    
    while (true) {
        const { results, next_cursor } = await notion.databases.query({
            database_id: database_id,
            start_cursor: cursor,
        });
        resultsAll = resultsAll.concat(results);
        if (!next_cursor) {
            break;
        }
        cursor = next_cursor;
    }

    return resultsAll;
}

async function queryBlock(block_id: string) {
    const block = await notion.blocks.children.list({
        block_id: block_id,
        page_size: 50
    });
    return block;
}

async function deleteBlock(block_id: string) {
    await notion.blocks.delete({
        block_id: block_id
    });
}

function checkBlock(block: any, type: string, title: string) : boolean {
    return block["type"] === type && String(block[type]["title"]).trim() === title;
}

function getName(obj: any) : string {
    return obj["properties"]["Name"]["title"][0]["plain_text"];
}

async function addTable(parentId: string, blockBeforeId: string, columnNumber: number, names: string[]) : Promise<AppendBlockChildrenResponse> {
    var response : AppendBlockChildrenParameters = {
        block_id: parentId,
        after: blockBeforeId,
        children: [
            {
                object: "block",
                table: {
                    table_width: columnNumber,
                    has_column_header: true,
                    children: [],
                }
            }
        ]
    };

    if (names.length > 0 && names.length < columnNumber * 2) {
        console.error("The number of names is not correct : names.lenght = " + names.length + " columnNumber = " + columnNumber);
        return;
    }

    response.children[0]["table"].children.push({
        table_row: {
            cells: []
        }
    });
    response.children[0]["table"].children.push({
        table_row: {
            cells: []
        }
    });

    for (var i = 0; i < columnNumber; i++)
        response.children[0]["table"].children[0].table_row.cells.push([{
            text: {
                content: names[i],
            },
            annotations: {
                color: parseInt(names[i]) >= 10 ? "green" : "default"
            }
        }]);
    for (var i = 0; i < columnNumber; i++)
        response.children[0]["table"].children[1].table_row.cells.push([{
            text: {
                content: names[i + columnNumber],
            },
            annotations: {
                color: parseInt(names[i + columnNumber]) >= 10 ? "green" : "default"
            }
        }]);
    
    return await notion.blocks.children.append(response);
}

function groubByUE(courses: any[]) : any {
    var coursesByUE = {};
    courses.forEach(course => {
        if (course["properties"]["UE"]["select"] === null) return;
        const ue = course["properties"]["UE"]["select"]["name"];
        if (coursesByUE[ue] === undefined) coursesByUE[ue] = [];
        coursesByUE[ue].push(course);
    });
    return coursesByUE;
}

function getLearningOfStudent(learnings: any[], student: any) : any[] {
    return learnings.filter(learning => {
        if (learning["properties"]["Élèves"]["rollup"]["array"][0] === undefined) return false;
        return learning["properties"]["Élèves"]["rollup"]["array"].find(r => r["relation"].find(e => e["id"] === student["id"]) !== undefined) !== undefined;
    });
}

function isCritical(learning: any) : boolean {
    return learning["properties"]["Criticité"]["select"]["name"] === "Oui";
}

function getLearningOfCourseStudent(course: any[], learningsOfStudent: any[]) : any[] {
    return learningsOfStudent.filter(learning =>
        isCritical(learning) && learning["properties"]["Cours"]["relation"].find(c => c["id"] === course["id"]) !== undefined
    );
}

function getLearningOfCourse(course: any[], learnings: any[]) : any[] {
    return learnings.filter(learning => 
        isCritical(learning) && learning["properties"]["Cours"]["relation"].find(c => c["id"] === course["id"]) !== undefined
    );
}

function getCoeff(course: any[]) : number {
    return course["properties"]["Coef"]["number"];
}

function calculateGradeOfCourse(learningsOfCourseStudent: any[], learningsOfCourse: any[], courseName: string, courseCoeff: number) : number[] {
    var grade = 0;
    var coeff = 0;

    if (learningsOfCourse.length === 0) return [0, 0];

    if (courseName.includes("Projets d’entreprise"))
        grade += Math.min(learningsOfCourseStudent.length / 12 * 20 * courseCoeff, 20 * courseCoeff);
    else {
        grade += learningsOfCourseStudent.length / learningsOfCourse.length * 20 * courseCoeff;
    }

    coeff += courseCoeff;

    return [grade, coeff];
}

function doTableExist(blocks: any) : boolean {
    return blocks.results.find(b => b["type"] === "table") !== undefined;
}

async function notionGrade() : Promise<void> {
    const students = await queryDatabase(process.env.NOTION_DATABASE_STUDENTS);
    const learnings = await queryDatabase(process.env.NOTION_DATABASE_LEARNINGS);
    const courses = await queryDatabase(process.env.NOTION_DATABASE_COURSES);

    const UEs = groubByUE(courses);

    students.forEach(async student => {
        const blocks = await queryBlock(student.id);
        const goodBlock = blocks.results.find(b => checkBlock(b, "child_database", "Calendrier absence"));

        if (goodBlock === undefined) {
            console.log("Can't insert the table after block for " + getName(student));
            return;
        }

        const numberOfUEs = Object.keys(UEs).length;
        var gradesTable = Object.keys(UEs);
        const learningsOfStudent = getLearningOfStudent(learnings, student);

        var grades = [];
        for (var i = 0; i < numberOfUEs; i++) {
            var grade = 0;
            var coeff = 0;

            UEs[Object.keys(UEs)[i]].forEach(course => {
                const learningsOfCourseStudent = getLearningOfCourseStudent(course, learningsOfStudent);
                const learningsOfCourse = getLearningOfCourse(course, learnings);

                const [g, c] = calculateGradeOfCourse(
                    learningsOfCourseStudent,
                    learningsOfCourse,
                    getName(course),
                    getCoeff(course)
                );
                grade += g;
                coeff += c;
            });

            grades.push(String(Math.round(grade / coeff * 100) / 100));
        }
        gradesTable = gradesTable.concat(grades);

        if (doTableExist(blocks))
            await deleteBlock(blocks.results.find(b => b["type"] === "table").id);

        await addTable(goodBlock["parent"]["page_id"], goodBlock.id, numberOfUEs, gradesTable);
    });
}

notionGrade();
// queryDatabase(process.env.NOTION_DATABASE_LEARNINGS).then(learnings => {
//     fs.writeFileSync("learnings.json", JSON.stringify(learnings, null, 4));
//     queryDatabase(process.env.NOTION_DATABASE_STUDENTS).then(students => {
//         var ls = [];
//         learnings.forEach(learning => {
//             if (getName(learning) === "Se présenter efficacement")
//                 {
//                 learning["properties"]["Élèves"]["rollup"]["array"].forEach(s => {
//                     ls = ls.concat(s["relation"]);
//                 });
//                 console.log(learning["properties"]["Élèves"]["rollup"]["array"]);
//                 }
//         });
//         ls = ls.filter((s, i, self) => self.findIndex(t => t["id"] === s["id"]) === i);
//         console.log(ls);
//         ls.forEach(s => {
//             console.log(getName(students.find(st => st["id"] === s["id"])));
//         });
//     });
// });
